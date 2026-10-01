# The delegate box — host notes

The box image is built from `Dockerfile` in this folder. `Dockerfile.dockerignore` lists the only files that enter the build. This README is not one of them.

## The hand-off folders (review C-4, N-12, R3-08 / issue G-7)

- `/handoff/in` is a **read-only** bind of the host folder `<home>/handoff/in` (`<home>` is `OPENCODE_DELEGATE_HOME`). The host writes the owner's bundle there; the box only reads it.
- `/handoff/out` is the named volume `handoff-out`. It is **not** a host folder, so code in the box cannot write anything on the host. The image creates `/handoff/out` owned by the box user (uid `10001`); Docker copies that owner into the empty volume on first use, on Windows and Linux alike. No host folder mode needs opening. The old host folder `<home>/handoff/out` (and its `0777` on Linux) is no longer used: on every start the bridge removes it with `rmdir` when it is empty, and leaves (and logs) one that is not empty.

How the session bundle leaves the box (`src/supervisor/workspaces-copyout.ts`):

1. In the box, `stat` (no `-L`) must report a regular file within the 500 MB cap, or nothing is copied.
2. The bridge runs `docker cp <box>:/handoff/out/<name> -` and reads the tar stream itself. It accepts at most one PAX header of up to 4 KiB, then exactly one non-empty regular-file entry no larger than the cap, then the two zero end blocks and nothing but zeros. A link, folder, device, empty file or second entry is refused. One deadline covers the whole copy. True bounds: at most the cap is written to the host; at most the cap plus 71 KiB of tar framing (headers, one PAX header, padding, end blocks and up to 64 KiB of trailing zeros) is consumed, plus at most one pipe chunk read ahead (64 KiB on the platforms tested). So a file swapped in after step 1 can never put more than the cap on the host.
3. The bridge writes the file with an exclusive create into a host-only folder (`<home>/workspaces/incoming`, never mounted), then checks it again: a regular file of exactly the streamed size, within the cap. Only then does it run `git fetch` (no hooks, every object checked).

The bridge removes the bundle from the volume after every collect, and on every box start and reuse it sweeps leftovers from a crashed collect (`rm -f -- /handoff/out/*-out.bundle`, a fixed glob; best effort, logged; `src/supervisor/handoff-hygiene.ts`). `oc_doctor` refuses a writable box volume that is not a plain `local` volume, or whose options hold `bind` or a `device` (a host folder in disguise).

## Base images

Both stages are pinned by version and digest (review C-9). To move to a new version, resolve the new digest with `docker buildx imagetools inspect <image>:<tag>` and update the `FROM` line.
