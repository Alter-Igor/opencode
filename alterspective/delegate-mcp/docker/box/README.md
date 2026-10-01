# The delegate box — host notes

The box image is built from `Dockerfile` in this folder. `Dockerfile.dockerignore` lists the only files that enter the build. This README is not one of them.

## The hand-off folders (review C-4, N-12, R3-08 / issue G-7)

- `/handoff/in` is a **read-only** bind of the host folder `<home>/handoff/in` (`<home>` is `OPENCODE_DELEGATE_HOME`). The host writes the owner's bundle there; the box only reads it.
- `/handoff/out` is the named volume `handoff-out`. It is **not** a host folder, so code in the box cannot write anything on the host. The image creates `/handoff/out` owned by the box user (uid `10001`); Docker copies that owner into the empty volume on first use, on Windows and Linux alike. No host folder mode needs opening (the old `0777` on `<home>/handoff/out` is gone).

How the session bundle leaves the box (`src/supervisor/workspaces-copyout.ts`):

1. In the box, `stat` (no `-L`) must report a regular file within the 500 MB cap, or nothing is copied.
2. The bridge runs `docker cp <box>:/handoff/out/<name> -` and reads the tar stream itself. It accepts exactly one regular-file entry no larger than the cap, and stops reading at the cap plus 64 KB. A link, folder, device or second entry is refused. So a file swapped in after step 1 can never put more than the cap on the host.
3. The bridge writes the file with an exclusive create into a host-only folder (`<home>/workspaces/incoming`, never mounted), then checks it again: a regular file of exactly the streamed size, within the cap. Only then does it run `git fetch` (no hooks, every object checked).

The bridge removes the bundle from the volume after every collect.

## Base images

Both stages are pinned by version and digest (review C-9). To move to a new version, resolve the new digest with `docker buildx imagetools inspect <image>:<tag>` and update the `FROM` line.
