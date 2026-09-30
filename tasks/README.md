# Substratic's site tasks

The shared build, publish and verify tooling for Substratic games, written in
Sigil shell. Each game keeps only its configuration, in `substratic.sgv` at its
root, plus its own check legs (its "arm"). The design is
the Substratic package-tasks design.

## Running a task

From sigil 0.22.11, inside a game that lists `substratic` as a dependency:

    sgx substratic:publish-web build/site --dry-run
    sigil task substratic:publish-web build/site --dry-run      (the same)

Before that release, run the file by path; the result is the same:

    sigil .sigil/deps/substratic/tasks/publish-web.sgl build/site --dry-run

Every task runs in the game's checkout (it finds the game's `package.sgl` from
the working directory, or takes `(project-root)` under `sigil task`), reads
`substratic.sgv` strictly, and prints its messages to stderr as `task: ...`.
External tools each task needs are declared at its top with `(requires (tools
...))`, which names every missing one at once.

## The path from a commit to the site

    sgx substratic:build-remote                  web build of HEAD on a runner
                                                 -> build/remote-web-<sha>/
    GAME_WEB_DIR=build/remote-web-<sha> \
      sgx substratic:stage-web build/site        the tree, DIR.pages, DIR.manifest
    sgx substratic:check-site build/site         the local gate -> DIR.verified
    sgx substratic:pages-dev-check build/site    (optional) Pages' own runtime, locally
    sgx substratic:publish-web build/site "why" --preview
    sgx substratic:publish-web build/site "why"  preview, verify-live, production

(`GAME_WEB_DIR` is the app's `web: env:` in `substratic.sgv`.)

| task | what it does |
|---|---|
| `build-remote` | builds exactly HEAD on a remote build runner (through `$AZOTH_REMOTE`, a lease helper) (refuses a dirty tree), streams the runner's output, files the web build only when the runner's completion marker names the sha. The runner side is the fixed script `runner/build-web.sh`. |
| `stage-web DIR` | copies the site files and the app's web build into DIR (under the checkout's `build/`), puts the wasm at `<route>/<sha16>/<app>.wasm` and rewrites the page's `data-wasm`, generates the Pages Function and `wrangler.json` into `DIR.pages/`, and writes `DIR.manifest`. |
| `check-site DIR` | hashes its gate files first, checks the tree against its manifest, serves it on loopback (`checks/serve-site.mjs`, Pages' rules), runs the shared legs (`checks/check-site.mjs`) and the game's arm, and writes `DIR.verified` only when all are green. |
| `publish-web DIR "why"` | refuses unless the tree, the verdict, the tools that gave it, HEAD and the checkout all still hold; copies the tree to a scratch deploy directory; puts the wasm in R2 only when the key is absent, reads it back and compares; deploys the preview, runs `verify-live` on its URL, then production. Never deletes. `--dry-run` does every check and writes nothing. |
| `verify-live URL DIR` | a deployment against its staged tree: every file byte for byte, the wasm through the Function with its headers and compressed on the wire, the redirects, the 404s. |
| `pages-dev-check DIR` | runs DIR through `wrangler pages dev` with a local R2 bucket (workerd through Guix's glibc loader) and `verify-live`s it. |
| `cloudflare-setup` | report; `--create` the project and bucket; `--domain` to attach the domains. The account owner runs it. |
| `host-site DIR` | serves a staged tree on the `host:` interface and ports (a private preview); `--stop`. |
| `tree-manifest DIR [ROOT]` | a deploy's identity (the games' `scripts/tree-manifest`, line for line). |
| `r2-s3 head\|get\|put` | one R2 object through R2's S3 API with a bucket-scoped token. |

## substratic.sgv

Read as data with `read`, never evaluated. An unknown section, an unknown key, a
repeated key or a value of the wrong shape is refused, naming the file and the
key. The keys are documented at the top of `substratic/tasks/config.sgl`;
The header of `config.sgl` lists every key.

## Credentials

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment if set,
else the pass entry `credentials: (pass "...")` names (token on line 1, an
`account: <id>` line). An absent entry, a locked gpg-agent (exit 77, checked
without raising a pinentry), a failing `pass` and a malformed entry are four
different messages. The values never go on a command line (curl reads them from
a config file in a mode-700 scratch directory) and every output that could hold
them is redacted. wrangler runs with `HOME` and `XDG_CONFIG_HOME` in an empty
scratch directory, so a `wrangler login` on the machine is never used.

## Layout

    tasks/*.sgl                    the tasks (declared in package.sgl, provides: script-tasks:)
    tasks/substratic/tasks/*.sgl   their libraries, (substratic tasks common|config|manifest|deploy|credentials|r2)
    tasks/substratic/load.sgl      loads the libraries for a task run by path
    tasks/checks/                  the Node checkers (check-site, verify-live, serve-site)
    tasks/templates/               the Pages Function template
    tasks/runner/build-web.sh      what build-remote runs on the runner
    tasks/test/                    the gates, their mocks and the sabotage driver

Nothing here is under `src/`, so no build compiles it into a game.

## The gates

Each prints PASS/FAIL lines and ends with `VERDICT: n/m passed`; exit 0 only if
every check passed. Run from any directory.

    sigil tasks/test/test-publish.sgl              stage-web, check-site, publish-web, credentials (fake game, R2 mock, stub wrangler)
    sigil tasks/test/test-stage-modes.sgl          copy: tracked, a stage hook, index mode, a variable mount, and their refusals
    sigil tasks/test/test-cloudflare-setup.sgl     against a Cloudflare API mock
    sigil tasks/test/test-no-deletes.sgl           the tripwire: no delete route anywhere in the tools
    sigil tasks/test/test-declarations.sgl         package.sgl's script-tasks entries
    sigil tasks/test/test-tree-manifest.sgl GAME/scripts/tree-manifest TREE...   vs a game's sh original
    sh GAME/scripts/test-r2-s3 tasks/test/r2-s3-sigil                           a game's own r2-s3 gate
    sigil tasks/test/test-deploy-differential.sgl GAME WEB-BUILD                what the game's sh path and these tasks would deploy

`tasks/test/sabotage.sh` proves each gate can fail: an unplanted control run per
gate, then one plant per guarded defect, each checked to have landed, each
required to turn its gate red.


## Linux release archives

Each game still fills its own archive (the layouts differ: one game puts
the executable in `bin/`, another at the top beside its data). These tasks are the
shared steps around that:

    sgx substratic:make-portable build/release/bin/GAME DIST/GAME-V/bin/GAME
    sgx substratic:check-linux-binary DIST/GAME-V/bin/GAME
    sgx substratic:smoke-ubuntu DIST/GAME-V --negative build/release/bin/GAME -- bin/GAME --some-probe
    sgx substratic:distro-play fedora dist/GAME-V-linux-amd64.tar.gz

| task | what it does |
|---|---|
| `make-portable IN OUT` | copies the executable and sets its ELF interpreter to `/lib64/ld-linux-x86-64.so.2` (a Guix build asks for a `/gnu/store` one that no other system has), then runs `check-linux-binary`; OUT is removed unless it passes. |
| `check-linux-binary FILE` | x86-64 ELF64; the standard interpreter; no `/gnu/store` path in RUNPATH, RPATH or NEEDED; only glibc's libraries; the glibc floor (printed, and at most `GLIBC_MAX`, default 2.35: Ubuntu 22.04). The games' `scripts/check-linux-binary`, output for output. |
| `smoke-ubuntu DIR [--negative FILE] -- CMD...` | runs CMD from the unpacked release in ubuntu-base 22.04.5 (sha256-pinned, cached under `$XDG_CACHE_HOME/substratic/`) through `unshare -r` and `chroot`, no root, 300 s. `--negative` first requires the unpatched build NOT to start there. The game's own gate compares CMD's output. |
| `distro-play DISTRO ARCHIVE [BINARY] [ARGS...]` | plays the archive in stock Ubuntu, Fedora, Debian or Arch through `docker run`, on this desktop's display, GPU and audio. A person runs it. |

## Not ported yet

- The games' `host` (their build/web preview server) stays in each game: it
  serves with the game's own `serve.mjs`, which differs from substratic's
  `tools/serve.mjs`.
- A site with two apps: `apps:` accepts one app so far.
