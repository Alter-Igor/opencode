# The delegate box — host notes

The box image is built from `Dockerfile` in this folder. `Dockerfile.dockerignore` lists the only files that enter the build. This README is not one of them.

## The hand-off `out/` folder on a Linux Docker host (review N-12)

The box writes its session bundle to `/handoff/out`. That path is a bind mount of the host folder `<home>/handoff/out`, where `<home>` is `OPENCODE_DELEGATE_HOME`.

- **Windows (Docker Desktop):** Docker Desktop maps permissions for bind mounts. The box user can write there. Nothing else is needed.
- **Linux (and any other non-Windows host):** a bind mount keeps the host owner and mode. The box runs as uid `10001`. So the host folder must be writable by uid `10001`. The supervisor sets mode `0777` on `<home>/handoff/out`, and only on that folder, whenever the host is not Windows (`handoffOutMode` in `src/supervisor/lifecycle.ts`).

### Why `0777` on that one folder is safe

- The host never runs anything from `out/`. It only reads bundles from there.
- The host treats everything in `out/` as untrusted, whoever wrote it (the box, or another local user):
  - it clears anything already sitting at the fresh bundle name before the box writes;
  - it takes the bundle by **rename** into a host-only folder (`<home>/workspaces/incoming`, never mounted), so nobody can swap it after the check;
  - it then refuses anything that is not a regular file (`lstat`: links are never followed) or is over the size cap;
  - only then does it run `git fetch` from the bundle, which runs no hooks.
- `in/` stays with the default mode and is mounted read-only in the box. Only `out/` is opened up.

The worst another local user can do is put a bad bundle in `out/`. The checks above refuse it, or the fetch fails. It can never run code on the host.

## Base images

Both stages are pinned by version and digest (review C-9). To move to a new version, resolve the new digest with `docker buildx imagetools inspect <image>:<tag>` and update the `FROM` line.
