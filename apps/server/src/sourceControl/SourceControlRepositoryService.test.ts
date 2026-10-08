import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GitCommandError,
  SourceControlProviderError,
  type SourceControlPublishRepositoryInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { GitHubCliAuthenticationError } from "./GitHubCli.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "./SourceControlRepositoryService.ts";

const CLONE_URLS = {
  nameWithOwner: "octocat/t3code",
  url: "https://github.com/octocat/t3code",
  sshUrl: "git@github.com:octocat/t3code.git",
};
const PUBLISH_INPUT = {
  cwd: "/workspace",
  provider: "github",
  repository: "octocat/t3code",
  visibility: "private",
  remoteName: "origin",
  protocol: "https",
} as const;

function publishGitFailure(operation: string) {
  return new GitCommandError({
    operation,
    command: "git",
    cwd: "/workspace",
    detail: "private command detail",
  });
}

function makeProvider(
  overrides: Partial<SourceControlProvider.SourceControlProvider["Service"]> = {},
): SourceControlProvider.SourceControlProvider["Service"] {
  const unsupported = (operation: string) =>
    Effect.die(`unexpected provider operation ${operation}`) as Effect.Effect<
      never,
      SourceControlProviderError
    >;

  return {
    kind: "github",
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => Effect.succeed(CLONE_URLS),
    createRepository: () => Effect.succeed(CLONE_URLS),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
    ...overrides,
  };
}

function processOutput(): GitVcsDriver.ExecuteGitResult {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function makeLayer(input: {
  readonly provider?: SourceControlProvider.SourceControlProvider["Service"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly fileSystem?: FileSystem.FileSystem;
}) {
  const serviceLayer = SourceControlRepositoryService.layer.pipe(
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        get: () => Effect.succeed(input.provider ?? makeProvider()),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed(processOutput()),
        ensureRemote: () => Effect.succeed("origin"),
        pushCurrentBranch: () =>
          Effect.succeed({
            status: "pushed" as const,
            branch: "feature/remote-v1",
            upstreamBranch: "origin/feature/remote-v1",
            setUpstream: true,
          }),
        ...input.git,
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(
        process.cwd(),
        input.fileSystem ? "/tmp/t3-source-control-repos" : { prefix: "t3-source-control-repos-" },
      ),
    ),
  );

  return input.fileSystem
    ? serviceLayer.pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, input.fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : serviceLayer.pipe(Layer.provideMerge(NodeServices.layer));
}

it.effect("looks up repositories through the requested provider without search", () => {
  const calls: Array<{ cwd: string; repository: string }> = [];
  const provider = makeProvider({
    getRepositoryCloneUrls: (input) =>
      Effect.sync(() => {
        calls.push({ cwd: input.cwd, repository: input.repository });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.lookupRepository({
      provider: "github",
      repository: "octocat/t3code",
      cwd: "/workspace",
    });

    assert.deepStrictEqual(result, { provider: "github", ...CLONE_URLS });
    assert.deepStrictEqual(calls, [{ cwd: "/workspace", repository: "octocat/t3code" }]);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("preserves provider failures without deriving the repository message from them", () => {
  const providerCause = new SourceControlProviderError({
    provider: "github",
    operation: "getRepositoryCloneUrls",
    cwd: "/workspace",
    repository: "octocat/t3code",
    detail: "credential token abc123 was rejected",
  });
  const provider = makeProvider({
    getRepositoryCloneUrls: () => Effect.fail(providerCause),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({
        provider: "github",
        repository: "octocat/t3code",
        cwd: "/workspace",
      }),
    );

    assert.strictEqual(error.provider, "github");
    assert.strictEqual(error.operation, "lookupRepository");
    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.strictEqual(
      error.message,
      "Source control repository operation lookupRepository failed for github: The source control operation could not be completed.",
    );
    assert.strictEqual(error.cause, providerCause);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect(
  "provides typed GitHub sign-in recovery without copying sensitive provider details",
  () => {
    const providerCause = new SourceControlProviderError({
      provider: "github",
      operation: "getRepositoryCloneUrls",
      cwd: "/workspace",
      detail: "credential token abc123 was rejected",
      cause: new GitHubCliAuthenticationError({
        command: "gh",
        cwd: "/workspace",
        cause: new Error("HTTP 401: Bad credentials"),
      }),
    });
    const provider = makeProvider({ getRepositoryCloneUrls: () => Effect.fail(providerCause) });

    return Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const error = yield* Effect.flip(
        service.lookupRepository({
          provider: "github",
          repository: "octocat/t3code",
          cwd: "/workspace",
        }),
      );

      assert.strictEqual(
        error.detail,
        "GitHub CLI is not authenticated. Run `gh auth login` on this repository's server, rescan Source Control in Settings, and retry.",
      );
      assert.ok(!error.message.includes("abc123"));
      assert.strictEqual(error.cause, providerCause);
    }).pipe(Effect.provide(makeLayer({ provider })));
  },
);

it.effect.each([
  {
    name: "an auth tag alone",
    cause: { _tag: "GitHubCliAuthenticationError" },
  },
  {
    name: "an auth tag with another command",
    cause: {
      _tag: "GitHubCliAuthenticationError",
      command: "git",
      cwd: "/workspace",
      cause: new Error("credential token abc123 was rejected"),
    },
  },
])("does not infer GitHub sign-in recovery from $name", ({ cause }) => {
  const providerCause = new SourceControlProviderError({
    provider: "github",
    operation: "getRepositoryCloneUrls",
    cwd: "/workspace",
    detail: "credential token abc123 was rejected",
    cause,
  });
  const provider = makeProvider({ getRepositoryCloneUrls: () => Effect.fail(providerCause) });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.lookupRepository({
        provider: "github",
        repository: "octocat/t3code",
        cwd: "/workspace",
      }),
    );

    assert.strictEqual(error.detail, "The source control operation could not be completed.");
    assert.ok(!error.message.includes("abc123"));
    assert.strictEqual(error.cause, providerCause);
  }).pipe(Effect.provide(makeLayer({ provider })));
});

it.effect("clones a looked-up repository into the requested destination", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-parent-",
    });
    const destinationPath = path.join(parent, "t3code");
    const cloneCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        provider: "github",
        repository: "octocat/t3code",
        destinationPath,
        protocol: "https",
      });

      assert.deepStrictEqual(result, {
        cwd: destinationPath,
        remoteUrl: CLONE_URLS.url,
        repository: { provider: "github", ...CLONE_URLS },
      });
      assert.deepStrictEqual(cloneCalls, [
        {
          cwd: parent,
          args: [
            "config",
            "--includes",
            "--name-only",
            "--get-regexp",
            "^(credential(\\..*)?\\.helper|includeif\\..*\\.path|init\\.templatedir)$",
          ],
        },
        {
          cwd: parent,
          args: ["clone", "--progress", CLONE_URLS.url, "t3code"],
        },
      ]);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneCalls.push({ cwd: input.cwd, args: input.args });
                return processOutput();
              }),
          },
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { name: "no configured helper", exitCode: 1, stdout: "", addHelper: true },
  { name: "an existing helper", exitCode: 0, stdout: "credential.helper\n", addHelper: false },
  {
    name: "an explicitly empty helper",
    exitCode: 0,
    stdout: "credential.helper\n",
    addHelper: false,
  },
  {
    name: "a partial-host helper",
    exitCode: 0,
    stdout: "credential.github.com.helper\n",
    addHelper: false,
  },
  {
    name: "conditional includes",
    exitCode: 0,
    stdout: "includeif.gitdir:~/work/.path\n",
    addHelper: false,
  },
  { name: "a custom template", exitCode: 0, stdout: "init.templatedir\n", addHelper: false },
  { name: "a failed config read", exitCode: 128, stdout: "", addHelper: false },
])("uses GitHub CLI for a clone with $name", ({ exitCode, stdout, addHelper }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-github-clone-auth-" });
    const commands: Array<ReadonlyArray<string>> = [];
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const result = yield* service.cloneRepository({
        remoteUrl: CLONE_URLS.url,
        destinationPath: path.join(parent, "checkout"),
      });
      assert.equal(result.remoteUrl, CLONE_URLS.url);
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                commands.push(input.args);
                return input.args[0] === "config"
                  ? { ...processOutput(), exitCode: ChildProcessSpawner.ExitCode(exitCode), stdout }
                  : processOutput();
              }),
          },
        }),
      ),
    );
    assert.deepStrictEqual(commands, [
      [
        "config",
        "--includes",
        "--name-only",
        "--get-regexp",
        "^(credential(\\..*)?\\.helper|includeif\\..*\\.path|init\\.templatedir)$",
      ],
      [
        "clone",
        "--progress",
        ...(addHelper
          ? ["--config", "credential.https://github.com.helper=!gh auth git-credential"]
          : []),
        CLONE_URLS.url,
        "checkout",
      ],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  "git@github.com:octocat/t3code.git",
  "http://github.com/octocat/t3code.git",
  "https://github.example.com/octocat/t3code.git",
  "https://github.com.evil.test/octocat/t3code.git",
  "https://user:synthetic-key@github.com/octocat/t3code.git",
  "https://github.com/octocat/t3code.git?access_token=synthetic-key",
  "https://github.com/octocat/t3code.git#custom-fragment",
])("does not configure a GitHub helper for %s", (remoteUrl) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-credential-scope-" });
    const commands: Array<ReadonlyArray<string>> = [];
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.cloneRepository({ remoteUrl, destinationPath: path.join(parent, "checkout") });
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                commands.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
    assert.deepStrictEqual(commands, [["clone", "--progress", remoteUrl, "checkout"]]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  {
    line: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    guidance: true,
  },
  {
    line: "fatal: Authentication failed for 'https://user:synthetic-key@github.com/acme/repo.git'",
    guidance: true,
  },
  { line: "fatal: repository 'https://github.com/acme/repo.git' not found", guidance: false },
])("offers GitHub clone recovery only for an authentication failure: $line", ({ line, guidance }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-github-clone-recovery-" });
    const error = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* Effect.flip(
        service.cloneRepository({
          remoteUrl: CLONE_URLS.url,
          destinationPath: path.join(parent, "checkout"),
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                if (input.args[0] === "config") return processOutput();
                yield* input.progress?.onStderrLine?.(line) ?? Effect.void;
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Synthetic authentication failure.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    );
    assert.isFalse(error.detail.includes("synthetic-key"));
    assert.equal(error.detail.includes("gh auth setup-git --hostname github.com"), guidance);
    assert.equal(error.detail.includes("this project's computer"), guidance);
    if (!guidance) assert.equal(error.detail, line);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports clone progress from git's stderr and keeps its error text on failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-source-control-clone-progress-",
    });
    const destinationPath = path.join(parent, "t3code");
    const progress: Array<{ stage: string; percent: number | null; detail: string | null }> = [];

    const stderrLines = [
      "Cloning into 't3code'...",
      "remote: Enumerating objects: 10, done.",
      "Receiving objects:  40% (4/10), 1.00 MiB | 2.00 MiB/s",
      "Receiving objects: 100% (10/10), 2.50 MiB | 2.00 MiB/s, done.",
      "fatal: early EOF",
      "fatal: unable to access 'https://user:s3c@ret@github.com/octocat/t3code.git/': could not resolve host",
    ];
    const error = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* Effect.flip(
        service.cloneRepository(
          { remoteUrl: CLONE_URLS.sshUrl, destinationPath },
          { onProgress: (line) => Effect.sync(() => void progress.push(line)) },
        ),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                for (const line of stderrLines) {
                  yield* input.progress?.onStderrLine?.(line) ?? Effect.void;
                }
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Git command exited with a non-zero status.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    );

    assert.deepStrictEqual(progress, [
      { stage: "counting", percent: null, detail: null },
      { stage: "receiving", percent: 40, detail: "1.00 MiB | 2.00 MiB/s" },
      { stage: "receiving", percent: 100, detail: "2.50 MiB | 2.00 MiB/s" },
    ]);
    // Git echoes the remote in some failures; the credentials must not follow.
    assert.strictEqual(
      error.detail,
      "fatal: early EOF fatal: unable to access 'https://github.com/octocat/t3code.git/': could not resolve host",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("strips embedded credentials from the remote URL it reports", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-redact-" });
    const destinationPath = path.join(parent, "t3code");
    const cloneArgs: Array<ReadonlyArray<string>> = [];
    const result = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      return yield* service.prepareClone({
        remoteUrl: "https://user:s3cret@github.com/octocat/t3code.git",
        destinationPath,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.sync(() => {
                cloneArgs.push(input.args);
                return processOutput();
              }),
          },
        }),
      ),
    );
    assert.equal(result.remoteUrl, "https://github.com/octocat/t3code.git");
    // Git itself still receives the credentials.
    assert.equal(result.cloneUrl, "https://user:s3cret@github.com/octocat/t3code.git");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("discards only a directory git wrote to", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-discard-" });
    const partial = path.join(parent, "partial");
    yield* fs.makeDirectory(path.join(partial, ".git"), { recursive: true });
    yield* fs.writeFileString(path.join(partial, "README.md"), "half");
    const foreign = path.join(parent, "foreign");
    yield* fs.makeDirectory(foreign);
    yield* fs.writeFileString(path.join(foreign, "notes.txt"), "mine");

    // A file where the directory should be must not be removed either.
    const replaced = path.join(parent, "replaced");
    yield* fs.writeFileString(replaced, "not a directory");

    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.discardClone(partial);
      const error = yield* Effect.flip(service.discardClone(foreign));
      assert.include(error.detail, "not from the clone");
      const replacedError = yield* Effect.flip(service.discardClone(replaced));
      assert.include(replacedError.detail, "could not be inspected");
      // A destination that never got created is nothing to discard.
      yield* service.discardClone(path.join(parent, "missing"));
    }).pipe(Effect.provide(makeLayer({})));

    // The partial clone is emptied but its directory (the workspace root) stays.
    assert.deepStrictEqual(yield* fs.readDirectory(partial), []);
    assert.deepStrictEqual(yield* fs.readDirectory(foreign), ["notes.txt"]);
    assert.strictEqual(yield* fs.readFileString(replaced), "not a directory");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("redacts query tokens and userinfo containing '@' from reported URLs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-source-control-redact2-" });
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const query = yield* service.prepareClone({
        remoteUrl: "https://github.com/octocat/t3code.git?access_token=s3cret",
        destinationPath: path.join(parent, "a"),
      });
      assert.equal(query.remoteUrl, "https://github.com/octocat/t3code.git");
      const nested = yield* service.prepareClone({
        remoteUrl: "https://user:pa@rt@github.com/octocat/t3code.git",
        destinationPath: path.join(parent, "b"),
      });
      assert.equal(nested.remoteUrl, "https://github.com/octocat/t3code.git");
    }).pipe(Effect.provide(makeLayer({})));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps clone snapshot URLs free of credentials, queries and fragments", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-snapshot-redaction-" });
    const marker = "synthetic-private-value";
    const cases = [
      {
        remoteUrl: `https://github.com/octocat/t3code.git#${marker}`,
        displayed: "https://github.com/octocat/t3code.git",
      },
      {
        remoteUrl: `https://user:${marker}@github.enterprise.test:8443/acme/repo.git?key=${marker}#${marker}`,
        displayed: "https://github.enterprise.test:8443/acme/repo.git",
      },
      {
        remoteUrl: `https://user:${marker}@github.com:invalid/acme/repo.git`,
        displayed: "Repository URL not saved",
      },
      { remoteUrl: CLONE_URLS.sshUrl, displayed: CLONE_URLS.sshUrl },
      { remoteUrl: "/local/repository", displayed: "/local/repository" },
    ];
    yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      for (const [index, input] of cases.entries()) {
        const result = yield* service.prepareClone({
          remoteUrl: input.remoteUrl,
          destinationPath: path.join(parent, String(index)),
        });
        assert.isFalse(result.remoteUrl.includes(marker), "snapshot must not expose credentials");
        assert.strictEqual(result.remoteUrl, input.displayed);
        assert.isTrue(result.cloneUrl === input.remoteUrl, "git must retain the original address");
      }
    }).pipe(Effect.provide(makeLayer({})));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("redacts URL credentials from clone failure text while retaining recovery details", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-clone-error-redaction-" });
    const marker = "synthetic-private-value";
    const lines = [
      `fatal: unable to access 'https://github.com/acme/repo.git?access_token=${marker}#${marker}': authentication failed`,
      `fatal: access denied (https://user:${marker}@github.enterprise.test:8443/acme/repo.git#${marker}).`,
      `fatal: unable to access "https://user:${marker}@github.com:invalid/acme/repo.git?key=${marker}": invalid port`,
      "fatal: repository not found; check the repository address and account permissions",
    ];
    const errors = yield* Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const collected: string[] = [];
      for (const index of lines.keys()) {
        const error = yield* Effect.flip(
          service.cloneRepository({
            remoteUrl: CLONE_URLS.url,
            destinationPath: path.join(parent, String(index)),
          }),
        );
        assert.isFalse(error.detail.includes(marker), "clone error must not expose credentials");
        collected.push(error.detail);
      }
      return collected;
    }).pipe(
      Effect.provide(
        makeLayer({
          git: {
            execute: (input) =>
              Effect.gen(function* () {
                const index = Number(input.args.at(-1));
                yield* input.progress?.onStderrLine?.(lines[index]!) ?? Effect.void;
                return yield* new GitCommandError({
                  operation: input.operation,
                  command: "git",
                  cwd: input.cwd,
                  detail: "Synthetic clone failure.",
                  exitCode: 128,
                });
              }),
          },
        }),
      ),
    );
    assert.deepStrictEqual(errors, [
      "fatal: unable to access 'https://github.com/acme/repo.git': authentication failed",
      "fatal: access denied (https://github.enterprise.test:8443/acme/repo.git).",
      'fatal: unable to access "Repository URL not saved": invalid port',
      lines[3],
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves destination probe failures instead of treating them as missing paths", () => {
  const fileSystemCause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: "/restricted/t3code",
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.cloneRepository({
        remoteUrl: CLONE_URLS.sshUrl,
        destinationPath: "/restricted/t3code",
      }),
    );

    assert.strictEqual(error.provider, "unknown");
    assert.strictEqual(error.operation, "cloneRepository");
    assert.strictEqual(error.cause, fileSystemCause);
  }).pipe(
    Effect.provide(
      makeLayer({
        fileSystem: FileSystem.makeNoop({
          exists: () => Effect.fail(fileSystemCause),
          makeDirectory: () => Effect.void,
        }),
      }),
    ),
  );
});

it.effect("publishes by creating the repository, adding a remote, and pushing upstream", () => {
  const createCalls: Array<{ cwd: string; repository: string; visibility: string }> = [];
  const remoteCalls: Array<{ cwd: string; preferredName: string; url: string }> = [];
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];
  const provider = makeProvider({
    createRepository: (input) =>
      Effect.sync(() => {
        createCalls.push({
          cwd: input.cwd,
          repository: input.repository,
          visibility: input.visibility,
        });
        return CLONE_URLS;
      }),
  });

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "feature/remote-v1",
      upstreamBranch: "origin/feature/remote-v1",
      status: "pushed",
    });
    assert.deepStrictEqual(createCalls, [
      { cwd: "/workspace", repository: "octocat/t3code", visibility: "private" },
    ]);
    assert.deepStrictEqual(remoteCalls, [
      { cwd: "/workspace", preferredName: "origin", url: CLONE_URLS.sshUrl },
    ]);
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider,
        git: {
          ensureRemote: (input) =>
            Effect.sync(() => {
              remoteCalls.push(input);
              return "origin";
            }),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: "origin/feature/remote-v1",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect("publishes to the remote name returned by ensureRemote", () => {
  const pushCalls: Array<{ cwd: string; remoteName: string | null | undefined }> = [];

  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.equal(result.remoteName, "origin-1");
    assert.deepStrictEqual(pushCalls, [{ cwd: "/workspace", remoteName: "origin-1" }]);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          ensureRemote: () => Effect.succeed("origin-1"),
          pushCurrentBranch: (cwd, _fallbackBranch, options) =>
            Effect.sync(() => {
              pushCalls.push({ cwd, remoteName: options?.remoteName });
              return {
                status: "pushed" as const,
                branch: "feature/remote-v1",
                upstreamBranch: `${options?.remoteName ?? "missing"}/feature/remote-v1`,
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

it.effect(
  "retains a created repository after a failed push and retries without creating it again",
  () => {
    let creates = 0;
    let connects = 0;
    const pushes: Array<string | null | undefined> = [];
    const provider = makeProvider({
      createRepository: () =>
        Effect.sync(() => {
          creates += 1;
          return CLONE_URLS;
        }),
    });
    return Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const first = yield* service.publishRepository(PUBLISH_INPUT);
      assert.equal(first.status, "push_pending");
      if (!("resume" in first)) return assert.fail("Expected a known-created recovery target");
      assert.deepStrictEqual(first.resume, {
        cwd: "/workspace",
        repository: { provider: "github", ...CLONE_URLS },
        remoteName: "origin-1",
        remoteUrl: CLONE_URLS.url,
      });
      assert.notInclude(first.detail, "private command detail");
      const retried = yield* service.publishRepository({ ...PUBLISH_INPUT, resume: first.resume });
      assert.equal(retried.status, "pushed");
      assert.equal(retried.remoteName, "origin-1");
      assert.equal(creates, 1);
      assert.equal(connects, 1);
      assert.deepStrictEqual(pushes, ["origin-1", "origin-1"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider,
          git: {
            ensureRemote: () =>
              Effect.sync(() => {
                connects += 1;
                return "origin-1";
              }),
            execute: (input) =>
              Effect.succeed({
                ...processOutput(),
                stdout:
                  input.args.length === 1 && input.args[0] === "remote"
                    ? "origin\norigin-1\n"
                    : input.args[1] === "get-url"
                      ? `${CLONE_URLS.url}\n`
                      : "",
              }),
            pushCurrentBranch: (_cwd, _branch, options) =>
              Effect.suspend(() => {
                pushes.push(options?.remoteName);
                return pushes.length === 1
                  ? Effect.fail(publishGitFailure("push"))
                  : Effect.succeed({
                      status: "pushed" as const,
                      branch: "feature/recovery",
                      upstreamBranch: "origin-1/feature/recovery",
                      setUpstream: true,
                    });
              }),
          },
        }),
      ),
    );
  },
);

it.effect("retains creation when adding the remote fails and resumes the exact connection", () => {
  let creates = 0;
  let pushes = 0;
  const added: ReadonlyArray<string>[] = [];
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const first = yield* service.publishRepository(PUBLISH_INPUT);
    assert.equal(first.status, "remote_pending");
    if (!("resume" in first)) return assert.fail("Expected a known-created recovery target");
    assert.equal(pushes, 0);
    const retried = yield* service.publishRepository({
      ...PUBLISH_INPUT,
      protocol: "ssh",
      remoteName: "other",
      resume: first.resume,
    });
    assert.equal(retried.status, "pushed");
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
    assert.deepStrictEqual(added, [["remote", "add", "origin", CLONE_URLS.url]]);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider: makeProvider({
          createRepository: () =>
            Effect.sync(() => {
              creates += 1;
              return CLONE_URLS;
            }),
        }),
        git: {
          ensureRemote: () => Effect.fail(publishGitFailure("remote add")),
          execute: (input) =>
            Effect.sync(() => {
              if (input.args[1] === "add") added.push(input.args);
              return processOutput();
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushes += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});

for (const changedDirection of ["fetch", "push"] as const) {
  it.effect(
    `refuses a changed ${changedDirection} destination before retrying a known publish`,
    () => {
      let creates = 0;
      let adds = 0;
      let pushes = 0;
      return Effect.gen(function* () {
        const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
        const error = yield* Effect.flip(
          service.publishRepository({
            ...PUBLISH_INPUT,
            resume: {
              cwd: "/workspace",
              repository: { provider: "github", ...CLONE_URLS },
              remoteName: "origin",
              remoteUrl: CLONE_URLS.url,
            },
          }),
        );
        assert.include(error.detail, "now points to another repository");
        assert.equal(creates, 0);
        assert.equal(adds, 0);
        assert.equal(pushes, 0);
      }).pipe(
        Effect.provide(
          makeLayer({
            provider: makeProvider({
              createRepository: () =>
                Effect.sync(() => {
                  creates += 1;
                  return CLONE_URLS;
                }),
            }),
            git: {
              ensureRemote: () =>
                Effect.sync(() => {
                  adds += 1;
                  return "origin";
                }),
              execute: (input) =>
                Effect.sync(() => {
                  if (input.args[1] === "add") adds += 1;
                  return {
                    ...processOutput(),
                    stdout:
                      input.args.length === 1
                        ? "origin\n"
                        : input.args.includes("--push") === (changedDirection === "push")
                          ? "https://github.com/someone/other-repository\n"
                          : `${CLONE_URLS.url}\n`,
                  };
                }),
              pushCurrentBranch: () =>
                Effect.sync(() => {
                  pushes += 1;
                  return {
                    status: "pushed" as const,
                    branch: "main",
                    upstreamBranch: "origin/main",
                    setUpstream: true,
                  };
                }),
            },
          }),
        ),
      );
    },
  );
}

it.effect(
  "rejects a resumed publish in another checkout or for another repository before doing work",
  () => {
    let calls = 0;
    const resume = {
      cwd: "/workspace",
      repository: { provider: "github" as const, ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.url,
    };
    const changed: SourceControlPublishRepositoryInput[] = [
      { ...PUBLISH_INPUT, cwd: "/other-checkout", resume },
      { ...PUBLISH_INPUT, repository: "someone/other", resume },
      { ...PUBLISH_INPUT, provider: "gitlab", resume },
      { ...PUBLISH_INPUT, resume: { ...resume, remoteUrl: "https://github.com/someone/other" } },
    ];
    return Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      for (const input of changed) {
        const error = yield* Effect.flip(service.publishRepository(input));
        assert.include(error.detail, "does not match this checkout and repository");
      }
      assert.equal(calls, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          provider: makeProvider({
            createRepository: () =>
              Effect.sync(() => {
                calls += 1;
                return CLONE_URLS;
              }),
          }),
          git: {
            execute: () =>
              Effect.sync(() => {
                calls += 1;
                return processOutput();
              }),
          },
        }),
      ),
    );
  },
);

it.effect("does not turn an ambiguous repository creation failure into a resume target", () => {
  let gitCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(service.publishRepository(PUBLISH_INPUT));
    assert.equal(error._tag, "SourceControlRepositoryError");
    assert.equal("resume" in error, false);
    assert.equal(gitCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider: makeProvider({
          createRepository: () =>
            Effect.fail(
              new SourceControlProviderError({
                provider: "github",
                operation: "createRepository",
                cwd: "/workspace",
                detail: "Connection lost after create request",
              }),
            ),
        }),
        git: {
          ensureRemote: () =>
            Effect.sync(() => {
              gitCalls += 1;
              return "origin";
            }),
        },
      }),
    ),
  );
});

it.effect("rejects a remote name that would be rewritten before creating a repository", () => {
  let creates = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const error = yield* Effect.flip(
      service.publishRepository({ ...PUBLISH_INPUT, remoteName: "my remote" }),
    );
    assert.include(error.detail, "remote name before publishing");
    assert.equal(creates, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        provider: makeProvider({
          createRepository: () =>
            Effect.sync(() => {
              creates += 1;
              return CLONE_URLS;
            }),
        }),
      }),
    ),
  );
});

it.effect("publish succeeds with status remote_added when the local repo has no commits", () => {
  let pushCalls = 0;
  return Effect.gen(function* () {
    const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
    const result = yield* service.publishRepository({
      cwd: "/workspace",
      provider: "github",
      repository: "octocat/t3code",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });

    assert.deepStrictEqual(result, {
      repository: { provider: "github", ...CLONE_URLS },
      remoteName: "origin",
      remoteUrl: CLONE_URLS.sshUrl,
      branch: "main",
      status: "remote_added",
    });
    assert.strictEqual(pushCalls, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        git: {
          execute: (input) =>
            input.args[0] === "rev-parse"
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git rev-parse --verify HEAD",
                    cwd: input.cwd,
                    detail: "fatal: Needed a single revision",
                  }),
                )
              : Effect.succeed(processOutput()),
          statusDetails: () =>
            Effect.succeed({
              isRepo: true,
              hasOriginRemote: true,
              isDefaultBranch: true,
              branch: "main",
              upstreamRef: null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
              hasUpstream: false,
              aheadCount: 0,
              behindCount: 0,
              aheadOfDefaultCount: 0,
            }),
          pushCurrentBranch: () =>
            Effect.sync(() => {
              pushCalls += 1;
              return {
                status: "pushed" as const,
                branch: "main",
                upstreamBranch: "origin/main",
                setUpstream: true,
              };
            }),
        },
      }),
    ),
  );
});
