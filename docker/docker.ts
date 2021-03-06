// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as pulumi from "@pulumi/pulumi";
import { RunError } from "@pulumi/pulumi/errors";

import * as child_process from "child_process";
import * as semver from "semver";

// Registry is the information required to login to a Docker registry.
export interface Registry {
    registry: string;
    username: string;
    password: string;
}

/**
 * CacheFrom may be used to specify build stages to use for the Docker build cache. The final image
 * is always implicitly included.
 */
export interface CacheFrom {
    /**
     * An optional list of build stages to use for caching. Each build stage in this list will be
     * built explicitly and pushed to the target repository. A given stage's image will be tagged as
     * "[stage-name]".
     */
    stages?: string[];
}

/**
 * DockerBuild may be used to specify detailed instructions about how to build a container.
 */
export interface DockerBuild {
    /**
     * context is a path to a directory to use for the Docker build context, usually the directory
     * in which the Dockerfile resides (although dockerfile may be used to choose a custom location
     * independent of this choice). If not specified, the context defaults to the current working
     * directory; if a relative path is used, it is relative to the current working directory that
     * Pulumi is evaluating.
     */
    context?: string;
    /**
     * dockerfile may be used to override the default Dockerfile name and/or location.  By default,
     * it is assumed to be a file named Dockerfile in the root of the build context.
     */
    dockerfile?: string;
    /**
     * An optional map of named build-time argument variables to set during the Docker build.  This
     * flag allows you to pass built-time variables that can be accessed like environment variables
     * inside the `RUN` instruction.
     */
    args?: {
        [key: string]: string;
    };
    /**
     * An optional CacheFrom object with information about the build stages to use for the Docker
     * build cache. This parameter maps to the --cache-from argument to the Docker CLI. If this
     * parameter is `true`, only the final image will be pulled and passed to --cache-from; if it is
     * a CacheFrom object, the stages named therein will also be pulled and passed to --cache-from.
     */
    cacheFrom?: boolean | CacheFrom;
}

let dockerPasswordPromise: Promise<boolean> | undefined;

function useDockerPasswordStdin(logResource: pulumi.Resource) {
    if (!dockerPasswordPromise) {
        dockerPasswordPromise = useDockerPasswordStdinWorker();
    }

    return dockerPasswordPromise;

    async function useDockerPasswordStdinWorker() {
        // Verify that 'docker' is on the PATH and get the client/server versions
        let dockerVersionString: string;
        try {
            // Get the version of docker, but do not forward the output of this command this to the
            // CLI to show the user.
            const versionResult = await runCLICommand(
                "docker", ["version", "-f", "{{json .}}"], logResource, /*reportStdout*/ false);
            // IDEA: In the future we could warn here on out-of-date versions of Docker which may not support key
            // features we want to use.
            dockerVersionString = versionResult.stdout!;
            pulumi.log.debug(`'docker version' => ${dockerVersionString}`, logResource);
        }
        catch (err) {
            throw new RunError("No 'docker' command available on PATH: Please install to use container 'build' mode.");
        }

        // Decide whether to use --password or --password-stdin based on the client version.
        try {
            const versionData: any = JSON.parse(dockerVersionString!);
            const clientVersion: string = versionData.Client.Version;
            return semver.gte(clientVersion, "17.07.0", true);
        }
        catch (err) {
            pulumi.log.info(`Could not process Docker version (${err})`, logResource);
        }

        return false;
    }
}

/**
 * @deprecated Use [buildAndPushImageAsync] instead.
 */
export function buildAndPushImage(
    imageName: string,
    pathOrBuild: string | DockerBuild,
    repositoryUrl: pulumi.Input<string>,
    logResource: pulumi.Resource,
    connectToRegistry: () => Promise<Registry>): pulumi.Output<string> {

    return pulumi.output(repositoryUrl).apply(repoUrl =>
        buildAndPushImageAsync(imageName, pathOrBuild, repoUrl, logResource, connectToRegistry));
}

// buildAndPushImageAsync will build and push the Dockerfile and context from [buildPath] into the
// requested ECR [repositoryUrl].  It returns the digest of the built image.
export async function buildAndPushImageAsync(
    imageName: string,
    pathOrBuild: string | DockerBuild,
    repositoryUrl: string,
    logResource: pulumi.Resource,
    connectToRegistry: () => Promise<Registry>): Promise<string> {

    let loggedIn: Promise<void> | undefined;
    const login = () => {
        if (!loggedIn) {
            pulumi.log.info("logging in to registry...", logResource);
            loggedIn = connectToRegistry().then(r => loginToRegistry(r, logResource));
        }
        return loggedIn;
    };

    // If the container specified a cacheFrom parameter, first set up the cached stages.
    let cacheFrom: Promise<string[] | undefined>;
    if (typeof pathOrBuild !== "string" && pathOrBuild && pathOrBuild.cacheFrom) {
        // NOTE: we pull the promise out of the repository URL s.t. we can observe whether or not it exists. Were we
        // to instead hang an apply off of the raw Input<>, we would never end up running the pull if the repository
        // had not yet been created.
        const cacheFromParam = typeof pathOrBuild.cacheFrom === "boolean" ? {} : pathOrBuild.cacheFrom;
        cacheFrom = pullCacheAsync(imageName, cacheFromParam, login, repositoryUrl, logResource);
    } else {
        cacheFrom = Promise.resolve(undefined);
    }

    // First build the image.
    const buildResult = await buildImageAsync(imageName, pathOrBuild, logResource, cacheFrom);

    // Use those then push the image.  Then just return the digest as the final result for our caller to use.
    if (!pulumi.runtime.isDryRun()) {
        // Only push the image during an update, do not push during a preview, even if digest and url are available
        // from a previous update.
        await login();

        // Push the final image first, then push the stage images to use for caching.
        await pushImageAsync(imageName, repositoryUrl, logResource);

        for (const stage of buildResult.stages) {
            await pushImageAsync(
                localStageImageName(imageName, stage), repositoryUrl, logResource, stage);
        }
    }

    return buildResult.digest;
}

async function pullCacheAsync(
    imageName: string,
    cacheFrom: CacheFrom,
    login: () => Promise<void>,
    repoUrl: string,
    logResource: pulumi.Resource): Promise<string[] | undefined> {

    // Ensure that we have a repository URL. If we don't, we won't be able to pull anything.
    if (!repoUrl) {
        return undefined;
    }

    pulumi.log.debug(`pulling cache for ${imageName} from ${repoUrl}`, logResource);

    // Ensure that we're logged in to the source registry and attempt to pull each stage in turn.
    await login();

    const cacheFromImages = [];
    const stages = (cacheFrom.stages || []).concat([""]);
    for (const stage of stages) {
        const tag = stage ? `:${stage}` : "";
        const image = `${repoUrl}${tag}`;
        const pullResult = await runCLICommand("docker", ["pull", image], logResource, /*reportStdout*/ true);
        if (pullResult.code) {
            pulumi.log.info(
                `Docker pull of build stage ${image} failed with exit code: ${pullResult.code}.`, logResource);
        } else {
            cacheFromImages.push(image);
        }
    }

    return cacheFromImages;
}

function localStageImageName(imageName: string, stage: string): string {
    return `${imageName}-${stage}`;
}

interface BuildResult {
    digest: string;
    stages: string[];
}

interface DockerInspectImage {
    Id: string;
    RepoDigests: string[];
}

async function buildImageAsync(
    imageName: string,
    pathOrBuild: string | DockerBuild,
    logResource: pulumi.Resource,
    cacheFrom: Promise<string[] | undefined>): Promise<BuildResult> {

    let build: DockerBuild;
    if (typeof pathOrBuild === "string") {
        build = {
            context: pathOrBuild,
        };
    } else if (pathOrBuild) {
        build = pathOrBuild;
    } else {
        throw new RunError(`Cannot build a container with an empty build specification`);
    }

    // If the build context is missing, default it to the working directory.
    if (!build.context) {
        build.context = ".";
    }

    pulumi.log.info(
        `Building container image '${imageName}': context=${build.context}` +
            (build.dockerfile ? `, dockerfile=${build.dockerfile}` : "") +
            (build.args ? `, args=${JSON.stringify(build.args)}` : ""), logResource);

    // If the container build specified build stages to cache, build each in turn.
    const stages = [];
    if (build.cacheFrom && typeof build.cacheFrom !== "boolean" && build.cacheFrom.stages) {
        for (const stage of build.cacheFrom.stages) {
            await dockerBuild(
                localStageImageName(imageName, stage), build, cacheFrom, logResource, stage);
            stages.push(stage);
        }
    }

    // Invoke Docker CLI commands to build.
    await dockerBuild(imageName, build, cacheFrom, logResource);

    // Finally, inspect the image so we can return the SHA digest. The image digest is found in the `RepoDigests`
    // section of the inspect results.

    // Do not forward the output of this command this to the CLI to show the user.

    const inspectResult = await runCLICommand(
        "docker", ["image", "inspect", imageName], logResource, /*reportStdout*/ false);
    if (inspectResult.code || !inspectResult.stdout) {
        throw new RunError(
            `No digest available for image ${imageName}: ${inspectResult.code} -- ${inspectResult.stdout}`);
    }

    // Parse the `docker image inspect` JSON
    let inspectData: DockerInspectImage;
    try {
        inspectData = <DockerInspectImage>(JSON.parse(inspectResult.stdout)[0]);
    } catch (err) {
        throw new RunError(`Unable to inspect image ${imageName}: ${inspectResult.stdout}`);
    }

    // Find the entry in `RepoDigests` that corresponds to the repo+image name we are pushing and extract it's digest.
    //
    // ```
    // "RepoDigests": [
    //     "lukehoban/atest@sha256:622cf8084812ee72845d603f41dc6b85cb595e20d0be05909008f1412e867bfe",
    //     "lukehoban/redise2e@sha256:622cf8084812ee72845d603f41dc6b85cb595e20d0be05909008f1412e867bfe",
    //     "k8s.gcr.io/redis@sha256:f066bcf26497fbc55b9bf0769cb13a35c0afa2aa42e737cc46b7fb04b23a2f25"
    // ],
    // ```
    //
    // We look up the untagged repo name, so drop any tags.
    const [untaggedImageName] = imageName.split(":");
    const prefix = `${untaggedImageName}@`;
    let digest = "";
    for (const repoDigest of inspectData.RepoDigests) {
        if (repoDigest.startsWith(prefix)) {
            digest = repoDigest.substring(prefix.length);
            break;
        }
    }

    return {
        digest: digest,
        stages: stages,
    };
}

async function dockerBuild(
    imageName: string,
    build: DockerBuild,
    cacheFrom: Promise<string[] | undefined>,
    logResource: pulumi.Resource,
    target?: string): Promise<void> {

    // Prepare the build arguments.
    const buildArgs: string[] = [ "build" ];
    if (build.dockerfile) {
        buildArgs.push(...[ "-f", build.dockerfile ]); // add a custom Dockerfile location.
    }
    if (build.args) {
        for (const arg of Object.keys(build.args)) {
            buildArgs.push(...[ "--build-arg", `${arg}=${build.args[arg]}` ]);
        }
    }
    if (build.cacheFrom) {
        const cacheFromImages = await cacheFrom;
        if (cacheFromImages) {
            buildArgs.push(...[ "--cache-from", cacheFromImages.join() ]);
        }
    }
    buildArgs.push(build.context!); // push the docker build context onto the path.

    buildArgs.push(...[ "-t", imageName ]); // tag the image with the chosen name.
    if (target) {
        buildArgs.push(...[ "--target", target ]);
    }

    const buildResult = await runCLICommand("docker", buildArgs, logResource, /*reportStdout*/ true);
    if (buildResult.code) {
        throw new RunError(`Docker build of image '${imageName}' failed with exit code: ${buildResult.code}`);
    }
}

async function loginToRegistry(registry: Registry, logResource: pulumi.Resource): Promise<void> {
    const { registry: registryName, username, password } = registry;

    const dockerPasswordStdin = await useDockerPasswordStdin(logResource);

    let loginResult: CommandResult;
    if (!dockerPasswordStdin) {
        loginResult = await runCLICommand(
            "docker", ["login", "-u", username, "-p", password, registryName], logResource, /*reportStdout*/ true);
    } else {
        loginResult = await runCLICommand(
            "docker", ["login", "-u", username, "--password-stdin", registryName],
            logResource, /*reportStdout*/ true, password);
    }
    if (loginResult.code) {
        throw new RunError(`Failed to login to Docker registry ${registryName}`);
    }
}

async function pushImageAsync(
        imageName: string, repositoryUrl: string, logResource: pulumi.Resource, tag?: string): Promise<void> {

    // Tag and push the image to the remote repository.
    if (!repositoryUrl) {
        throw new RunError("Expected repository URL to be defined during push");
    }

    tag = tag ? `:${tag}` : "";
    const targetImage = `${repositoryUrl}${tag}`;

    const tagResult = await runCLICommand(
        "docker", ["tag", imageName, targetImage], logResource, /*reportStdout*/ true);

    if (tagResult.code) {
        throw new RunError(`Failed to tag Docker image with remote registry URL ${repositoryUrl}`);
    }
    const pushResult = await runCLICommand("docker", ["push", targetImage], logResource, /*reportStdout*/ true);
    if (pushResult.code) {
        throw new RunError(`Docker push of image '${imageName}' failed with exit code: ${pushResult.code}`);
    }
}

interface CommandResult {
    code: number;
    stdout?: string;
}

// Runs a CLI command in a child process, returning a promise for the process's exit. Both stdout
// and stderr are redirected to process.stdout and process.stder by default.
//
// If the [stdin] argument is defined, it's contents are piped into stdin for the child process.
//
// [resourceOpt] is used to specify the resource to associate command output with. Stderr messages
// are always sent (since they may contain important information about something that's gone wrong).
// Stdout messages will be logged to this resource if reportStdout is provided. Otherwise that output
// will not be presented to the user.
async function runCLICommand(
    cmd: string,
    args: string[],
    resourceOpt: pulumi.Resource | undefined,
    reportStdout: boolean,
    stdin?: string): Promise<CommandResult> {

    // Generate a unique stream-ID that we'll associate all the docker output with. This will allow
    // each spawned CLI command's output to associated with 'resource' and also streamed to the UI
    // in pieces so that it can be displayed live.  The stream-ID is so that the UI knows these
    // messages are all related and should be considered as one large message (just one that was
    // sent over in chunks).
    //
    // We use Math.random here in case our package is loaded multiple times in memory (i.e. because
    // different downstream dependencies depend on different versions of us).  By being random we
    // effectively make it completely unlikely that any two cli outputs could map to the same stream
    // id.
    //
    // Pick a reasonably distributed number between 0 and 2^30.  This will fit as an int32
    // which the grpc layer needs.
    const streamID = Math.floor(Math.random() * (1 << 30));

    return new Promise<CommandResult>((resolve, reject) => {
        const p = child_process.spawn(cmd, args);
        let result: string | undefined;

        // We store the results from stdout in memory and will return them as a string.
        const chunks: Buffer[] = [];
        p.stdout.on("data", (chunk: Buffer) => {
            if (reportStdout) {
                pulumi.log.info(chunk.toString(), resourceOpt, streamID);
            }
            chunks.push(chunk);
        });

        p.stdout.on("end", () => {
            result = Buffer.concat(chunks).toString();
        });

        p.stderr.on("data", (chunk: Buffer) => {
            // 'warn' is deliberate here.  Docker prints warnings to stderr.  So if we
            // reported these as 'errors' it would be escalating warnings higher than
            // they should be.  Any true errors should actually result in the process
            // producing an error code out which we catch with p.on("close") below.
            pulumi.log.warn(chunk.toString(), resourceOpt, streamID);
        });

        p.on("error", err => {
            reject(err);
        });

        p.on("close", code => {
            resolve({
                code: code,
                stdout: result,
            });
        });

        if (stdin) {
            p.stdin.end(stdin);
        }
    });
}
