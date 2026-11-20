# GadgetsPOS Desktop 2.0: performance

What changed against version 1.6.1 and why, what was measured, how to measure it again, and how to switch the risky part off. Checked
on 2026-11-19. Every number below comes from `tests/perf/out/benchmark.json` (the same data is in `benchmark.md` next to it).

## 1. In short

- **Smoother and lighter, from one change.** Version 2 draws the screen with the computer's graphics card. On the stress page of the
  benchmark that took scrolling and animation from 16.6 to 60.0 frames per second, and it cut the memory of the whole app from 340 MB
  to 234 MB. With hardware acceleration switched off ("compatibility mode") version 2 measured about the same as version 1 on both.
- **Not faster to start.** The first thing on screen appears at the same moment as in version 1 (1.1 s on the test Mac). In version 1
  it is a blank window, in version 2 the GadgetsPOS loading screen. The POS page finishes loading at the same time (1.32 s against
  1.33 s).
- **Two of the four budgets of the SPEC were missed:** the loading screen is not 25 % sooner than version 1's first window, and the
  main-process boot is 502 ms, not 400 ms or less (section 3.5).
- **Two things are slightly worse:** the idle CPU (0.10 % of one core against 0.03 %) and the print path (about 1 ms more per job than
  version 1's handler, with the printers stubbed).
- **Measured on a Mac developer machine with fake printers, not on a shop PC.** Nothing here was measured on Windows, with a real
  graphics driver or with a real printer (section 7). Try hardware acceleration on the oldest shop PC first (section 8).

## 2. What changed against version 1, and why

The list of problems is the one in SPEC 18b, checked against version 1.6.1's own `index.js` (git commit `14df69a`).

| Version 1 | Version 2 | Measured? |
| --- | --- | --- |
| Software rendering for everybody: `app.disableHardwareAcceleration()` since 2025-11-05 (section 6). A heavy POS page then scrolls and animates on the CPU. | Hardware acceleration is on by default, with five ways back to compatibility mode (section 5). Chromium's own list of broken graphics drivers stays active. | **Yes.** Stress page 16.6 to 60.0 fps; memory 340 to 234 MB (section 3). |
| A 1,919-line `index.js` that loads PDFKit on its first lines, at boot. | The main process is built from small modules. The loading screen is created first; heavy modules come after it: `electron-store` while the loading page renders, `electron-log` once it is drawn, `electron-updater` 10 s after the POS has loaded. PDFKit and the dead A4 generator are gone, and the runtime packages went from 16 to 3. | **Partly.** The loading screen and the POS page appear no sooner than in version 1, and two budgets were missed (3.5). |
| A hidden DYMO window that the app never closes. (SPEC 18b says it is created at startup. Version 1.6.1's code creates it on the first DYMO label, inside the label handler, and keeps it for ever.) | Created on the first DYMO label, shared by every later label, destroyed after 10 idle minutes. The DYMO printer list is cached for 30 s and the label files are read once. | **No.** No DYMO label was printed in the benchmark. Both versions ran 4 processes at idle. |
| A `cmd.exe` process for every print: `cmd /c copy /B <file> <port>`. | Windows, installed printer: one long-lived PowerShell process, started on the first job, reused, stopped after 10 idle minutes, started again after a crash or a stuck job; the one-shot script is the fallback. Windows, legacy port: written straight from Node, with `copy` only as a one-time fallback. | **Partly.** A test proves one start for 50 jobs. The app's own overhead for the second and later job measured 2.9 ms with the printer stubbed (budget 150 ms). Real Windows printing was not measured. |
| Spellcheck on (Electron's default). | `spellcheck: false` on every window. | No. |
| The POS window slows its timers and sockets when it is minimised or covered. | Background throttling is switched off once the POS is on screen, so timers, connections and order sounds keep running; Windows' own "covered window is hidden" detection is off too. | No. |
| No early connection to the server. | The connection is opened (4 sockets) as soon as the address is known, and again before every reconnect attempt. | **No.** The benchmark server is on the same machine, so the saving (DNS, TCP, TLS) is invisible. |
| Nothing special on quit. | The print queue is drained for up to 5 s, then the DYMO window, the PowerShell process and the timers are stopped, so the last receipt is not lost. | No (covered by tests). |
| Chromium's default cache size. | `disk-cache-size` 512 MB, so the POS's bundles are kept between starts. | No. |
| No startup numbers. | Marks for every startup step, in the log (one line), in Settings > About & updates > Startup details and in Copy diagnostics. | n/a |

Also by design: nothing polls while idle. The connection probes run only while the app is offline (the offline screen, or the bar
after two failed requests), and the update and idle-dispose timers do not keep the process alive. Settings and the password window are
created when needed and destroyed when closed. The log rotates at 5 MB across three files.

## 3. The measured numbers

### 3.1 How and where

The run started on 2026-11-19 at 20:50 UTC and ended at 21:33 UTC (39.8 minutes). The report is assembled from three runs of the same
script (start, frame rate and printing; a diagnosis of the loading screen; a 4-minute idle drift).

- **Machine:** Intel Core i9-9880H (2.3 GHz, 16 logical cores), 16 GB, macOS 26.2, on mains power. macOS Low Power Mode was **on**, for
  both versions alike, so read the ratios more than the absolute numbers.
- **Builds:** version 1 is 1.6.1 (commit `14df69a`) from `git archive`, with five small patches (the benchmark URL, no stealing of focus,
  a window size knob, a stand-in for `exec`, a platform check). Version 2 is branch `feature/desktop-v2` at `14df69a` with uncommitted
  changes. **The same Electron 32.3.3 binary** runs both, both **unpackaged**, against a local server.
- **Method:** 5 cold starts of each (a fresh `--user-data-dir` every time), taking turns, medians with (minimum to maximum). No window
  took focus: 90 samples of the frontmost application showed none of the benchmark's own processes. 66 processes were started and none
  was left running. No phase failed.
- **Source edited since.** Nineteen files were changed after the run, between 22:51 and 23:32 UTC by their modification times, among
  them `src/main/index.js`, `src/main/perf.js`, `src/main/windows/main.js` and `src/preload/app.js`. Run the benchmark again
  (section 4) before quoting these numbers in a release note.
- "v2 (harness)" is the end-to-end harness, which adds a control server and an events file. "v2 lean" is the same `bootstrap()` with
  nothing else, so the difference between the two columns is what the harness costs.

### 3.2 Start-up, memory and idle CPU

| Metric | v1 | v2 (harness) | v2 lean | v2 / v1 |
| --- | --- | --- | --- | --- |
| First window, ms (spawn to the first page target) | 1114 (1103-1289) | 831 (812-840) | 816 (798-833) | 0.75 |
| Loading screen shown, ms (v1: its first, blank, window) | 1114 (1103-1289) | 1115 (1095-1121) | 1092 (1080-1198) | 1.00 |
| Main-process boot, ms (app ready to loading screen) | - | 502 (496-509) | 506 (498-597) | - |
| POS page loaded, ms | 1332 (1327-1517) | 1323 (1301-1329) | 1324 (1310-1463) | 0.99 |
| Memory of all processes after 30 s idle, MB | 339.6 (339.4-340.5) | 233.7 (233.5-233.9) | 233.3 (233.1-233.4) | 0.69 |
| Memory after 60 s idle, MB | 339.6 (339.5-340.6) | 235.1 (234.9-235.2) | 234.7 (234.5-234.8) | 0.69 |
| Processes | 4 | 4 | 4 | - |
| Idle CPU, 30-60 s after load, % of one core | 0.03 (0.00-0.03) | 0.10 (0.07-0.13) | 0.10 (0.07-0.10) | 3.03 |
| CPU, first 30 s after load, % of one core | 1.14 (1.07-1.17) | 1.14 (1.10-1.21) | 0.77 (0.74-0.81) | 1.00 |

How to read it:

- The "first window" row is not a fair win. Version 2's window exists after 0.8 s but stays hidden until the loading page has painted;
  what the cashier sees first is the "loading screen" row, which is the same time as version 1's blank window (1.1 s). Of version 2's
  502 ms boot, 185 ms is from "app ready" to the window being created, and 316 ms from then to the loading screen being shown (the
  page's renderer process starting and painting). About 0.6 s passes before "app ready" at all, which is Electron starting.
- The memory by process role after 30 s idle: version 1 main 106.3, GPU 104.9, renderer 103.6, network 24.8 MB; version 2 main 100.9,
  GPU 44.1, renderer 63.8, network 24.9 MB. Version 1's GPU process was a software renderer (SwiftShader).
- The idle CPU is worse by 0.07 % of one core. The benchmark calls it real but small (below the 0.15 % that is noticeable). The drift
  run shows why: from 60 to 240 s version 2 idles at 0.056 % against version 1's 0.050 %, and its memory moved 0.8 MB (version 1: 0.9
  MB), with a single 1.4 MB step in the renderer between 30 and 60 s. A one-time event, not a timer and not a leak.

### 3.3 Smoothness: the stress page

A deliberately heavy page: a 3000-row list, 24 moving translucent cards with shadows, and a scrolling animation, counted with
`requestAnimationFrame` for 8 s, 5 runs, the same window size.

| Mode | Frames per second | 95th percentile frame, ms | Slow frames (over 25 ms) | CPU cores used |
| --- | --- | --- | --- | --- |
| v1 (software rendering) | 16.6 (16.4-16.7) | 98.4 (68.6-99.9) | 127 (124-131) | 1.37 |
| v2 default (hardware acceleration) | 60.0 (60.0-60.0) | 18.6 (18.6-18.6) | 0 | 0.56 |
| v2 compatibility mode (acceleration off) | 16.6 (16.5-16.6) | 97.9 (68.7-99.9) | 127 (124-127) | 1.37 |

Version 2 with acceleration is 3.61 times version 1 in frames per second, with 0.19 times the frame time. In compatibility mode it is
the same as version 1 (1.00). The hardware result is capped by this display's 60 Hz. The browser's own GPU report agrees: version 1 and
compatibility mode show `gpu_compositing` and `rasterization` as software; version 2 shows both enabled.

The same holds for memory. In the idle-drift run, one run each: version 1 about 341 MB, version 2 with acceleration about 234 MB,
version 2 in compatibility mode about 335 MB.

### 3.4 Print jobs

50 jobs back to back, 5 runs, times in ms, medians. Nothing was printed: version 1's `exec` and version 2's `lp` were stubbed, so
this is the app's own work (queue, temp file, answer). A real Windows print adds the printer's own time to every job in both versions.

| 50 receipts | First job at the printer | All 50 at the printer | Per job | Answer to the page: first | All 50 | One at a time |
| --- | --- | --- | --- | --- | --- | --- |
| v1 handler, `exec` stubbed | 12.26 | 42.5 | 0.16 | - | - | - |
| v2, old-web path, real raw printer | 14.63 | 87.2 | 1.23 | - | - | - |
| v2, new-web path (acknowledged), real raw printer | 11.71 | 84.0 | 1.29 | 15.90 | 85.1 | 1.70 |

| 50 labels | First job at the printer | All 50 at the printer | Per job | Answer to the page: first | All 50 | One at a time |
| --- | --- | --- | --- | --- | --- | --- |
| v1 handler, `exec` stubbed | 29.76 | 31.7 | 0.04 | - | - | - |
| v2, old-web path, real raw printer | 7.49 | 76.8 | 1.22 | - | - | - |
| v2, new-web path (acknowledged), real raw printer | 6.87 | 76.2 | 1.24 | 8.10 | 77.1 | 1.60 |

"At the printer" is when the stubbed printer program was reached, in the main process; "per job" is the median gap between two finished
jobs; "answer to the page" is when the page got the acknowledgement (version 1 never answers); "one at a time" is the answer time of
a job sent after the previous one was answered. "Real raw printer" means version 2's real temp file, queue and CUPS transport with only
`lp` stubbed, which is the same thing the patch does to version 1's `exec`.

Version 2's path costs about 1 ms more per job than version 1's fire-and-forget handler (50 jobs: 87 ms against 43 ms), because it
queues the job, gives it its own temp file and answers it. The benchmark marks 8 of its 10 print comparisons as worse. The two that
came out better are about the first label of a batch (7.5 ms against 29.8 ms to the printer, 8.1 ms to the answer). One at a time, a
version 2 job is answered in 1.6 to 1.7 ms, which is how the new web app prints a batch.

### 3.5 The four budgets of SPEC 18b

| Budget | Limit | Measured | Result |
| --- | --- | --- | --- |
| Time to the loading screen, at most 0.75 times version 1's time to its first window | 836 ms | 1115 ms (1095-1121), ratio 1.00 | **missed** |
| Main-process boot (app ready to loading screen) | 400 ms or less | 502 ms (496-509) | **missed** |
| Memory of all processes after 30 s idle, at most 0.85 times version 1 | 288.7 MB | 233.7 MB (233.5-233.9), ratio 0.69 | passed |
| Overhead of the second and later print job, excluding the printer | under 150 ms | 2.86 ms (largest 95th percentile) | passed |

### 3.6 What the numbers say

- Hardware acceleration is where the measured benefit is: smoothness and memory. The other items of the SPEC (loading what is needed
  later, one print process, no idle polling, no spellcheck) are in place, but the benchmark shows them neither helping nor hurting
  start-up, and the two start-up budgets were missed.
- Start-up is no faster than version 1's. If a faster start is wanted, the time of the app's own part is in the 316 ms between the
  window and the first paint (a new renderer process starting) and the 185 ms before the window; about 0.6 s before that is Electron.
- The memory and frame-rate gain depends on a graphics driver that works. That is why compatibility mode exists (section 5).

## 4. How to run the benchmark again

`tests/perf/benchmark.js` is a plain Node script. It is not a unit test, so `npm test` does not run it.

```
node tests/perf/benchmark.js          # the full run, about 40 minutes
node tests/perf/benchmark.js --quick  # a smoke run of every phase, about 4 minutes
```

- **Where:** macOS (where it was run). It reads the process table with `ps`, so Linux may work; **Windows is not supported.** It starts
  real Electron windows, so it needs a machine with a display, but no window takes focus.
- **What it needs:** `npm install` done in this folder, and a checkout of version 1 next to it (the default is `../Electron-app`) that
  contains commit `14df69a`; use `--v1-repo=<folder>` for another place. It only reads that checkout (`git archive`).
- **Keep the machine quiet** while it runs: plug in the power, switch Low Power Mode off, close other programs. The report records
  the power state, the load before and after, the busiest other processes and whether the screen was locked, so a noisy run shows.
- **Options:** `--runs`, `--idle`, `--fps-runs`, `--fps-seconds`, `--print-runs`, `--print-count`, `--phases=start,fps,print,diag,drift`
  (`drift` is off by default and adds 13 minutes), `--merge` (keep the other phases of the earlier `benchmark.json` and re-run only the
  phases you name), `--no-warmup`, `--out=<folder>`.
- **Output:** `tests/perf/out/benchmark.json` (every sample) and `tests/perf/out/benchmark.md` (the tables above, plus the findings and
  the limits of the run). The exit code is 0 when it ran, 1 when a phase failed, 2 when the harness itself broke. It does **not** judge the
  numbers: read the "SPEC 18b budgets" and "Findings" parts of `benchmark.md`.
- The arithmetic of the harness (medians, ratios, the 5-run rule) has its own tests: `node --test "tests/perf/benchmark-lib.test.js"`.

## 5. The compatibility switches

Hardware acceleration is the one change that can go wrong on a particular computer, so there are five ways back. Four of them write a
file called `flags.json` in the data folder (Settings > About & updates shows the folder); the shortcut argument needs no file.

| Way | How | What happens |
| --- | --- | --- |
| Settings | Settings > General > Hardware acceleration, off | Writes `disableGpu: true`; a **Restart now** button appears. A note "Compatibility mode is on" then says why. |
| Help menu | Help > Compatibility mode (a tick box) | The same, from a native menu that works when the screen inside the window is blank, black or garbled. A native box offers **Restart now**. |
| Shortcut | add `--disable-gpu` to the end of the Target of the shortcut | Always wins over everything else. Settings refuses to turn acceleration on while it is there. SHOP-SETUP.md has the steps. |
| By itself | The graphics process stops twice within 60 s, or the POS page's renderer crashes (`crashed`, `launch-failed` or `integrity-failure`) within 20 s of its start | Writes `disableGpu: true` with the reason `gpu-crashes` or `renderer-crash-at-start`, and a native box says "The screen had a problem. GadgetsPOS will use compatibility mode." with **Restart now** and **Later**. |
| After an upgrade | The first start after version 1's settings were migrated: about 20 s later a native box asks "Does the screen look right?" | **No, use compatibility mode** writes the flag and restarts. Either answer stores `gpuChecked: true`, so it is never asked again. A blank or garbled screen crashes no process, which is why the question exists. |

`flags.json` is read synchronously before the app is ready (Chromium reads its switches that early). Written by the app atomically
(temporary file, then rename), mode 0600; a damaged file is ignored and the defaults are used. To edit it by hand, close GadgetsPOS
first.

```json
{ "disableGpu": false, "disableBrotli": true, "reason": "", "gpuChecked": false }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `disableGpu` | `false` | `true` is compatibility mode: hardware acceleration off. |
| `disableBrotli` | `true` | Adds the Chromium switch `disable-brotli`, as version 1 did (section 6). |
| `reason` | `""` | Why compatibility mode is on: `manual`, `gpu-crashes` or `renderer-crash-at-start`. Shown in Settings > General. At most 200 characters. |
| `gpuChecked` | `false` | The "Does the screen look right?" question has been answered. |

Other switches the app sets, which cannot be changed from outside: a 512 MB disk cache; on Windows `disable-features=
CalculateNativeWinOcclusion`. `ignore-gpu-blocklist` is never passed, so a graphics card or driver that Chromium knows to be bad is
still handled in software by Chromium itself.

To see what GadgetsPOS asked for: the log line at the start ("GadgetsPOS 2.0.0 is starting (win32, installed, hardware acceleration
on)") and the line "Hardware acceleration" in Help > Copy diagnostics. They show the choice, not what Chromium finally decided for a
graphics card on its blocklist.

## 6. Version 1's two unexplained switches

Both are in the history of version 1, with no note about why.

- **Hardware acceleration off.** `app.disableHardwareAcceleration()` was added on **2025-11-05** in commit `b41a346`, whose message is
  just "updates". It is a 24-file commit that also added the DYMO files, so a problem met while building DYMO support is one
  possible reason, but nothing in the repository says so. Every build since then, 1.6.1 included, has used software rendering. Version 2
  turns acceleration back on, and compatibility mode is that old behaviour.
- **`disable-brotli`.** Added on **2026-09-17** in commit `aeea634` ("improvements"), also without a reason. Version 2 keeps it by
  default (`disableBrotli: true`) so as to change nothing unasked. A search of the Electron 32.3.3 framework file on the Mac finds the
  names of real switches such as `disk-cache-size`, `disable-features` and `ignore-gpu-blocklist`, but **not** `disable-brotli`, so it
  very probably does nothing in this Electron. Worth testing: set `"disableBrotli": false`, restart, and check that the usual POS pages
  load on a test PC. If nothing changes, the switch can go.

## 7. What could not be measured here

- **Windows, at all.** Every number comes from one Mac. The shops run Windows: the PowerShell print process, the Windows window
  handling and the updater are covered by unit tests, and the installer by static checks, not by these numbers.
- **Windows graphics drivers.** The Mac's 60 frames per second is limited by its display, and its GPU process used 44 MB against
  version 1's 105 MB of software rendering. A Windows integrated graphics driver may behave very differently, and may use more memory.
- **Real printers.** All print numbers have the printer program stubbed. The first receipt through an installed printer on Windows
  starts PowerShell and compiles a small helper, and has not been timed; later ones skip that.
- **DYMO.** No DYMO label was timed.
- **The installed app.** Both versions ran unpackaged. Version 2 ran with its development logging and development origin rules, and
  neither version had the installer's archive.
- **A real network.** The server was local, so the early connection (50 to 300 ms on a real network, the benchmark's own estimate) is
  not in the numbers.
- **Slow computers and long sessions.** The Mac has 16 logical cores and 16 GB, and every start was cold in a clean data folder. The
  idle memory was watched for 4 minutes, one run per variant. A shop PC after a day of use was not measured.
- **The current source.** See section 3.1: files changed after the run.

## 8. Recommendation: try hardware acceleration on the oldest shop PC first

The gain is large where the graphics driver works, and the risk sits in the oldest graphics hardware and drivers. So:

1. Install version 2 first on the oldest or weakest PC that a shop uses, with its graphics driver as it is (acceleration is on by
   default).
2. Use it for a normal trading day. Look for flicker, a blank or black window, torn drawing, and a stuck POS. Answer the "Does the
   screen look right?" question honestly. Check the log line at the start that says "hardware acceleration on".
3. If anything is wrong: Help > Compatibility mode (section 5). Then try updating that PC's graphics driver and switch acceleration
   on again.
4. Only then roll version 2 out to the other PCs. Keep Help > Compatibility mode in mind as the answer to "the screen looks wrong".
5. Measure on that PC what matters to the shop: how smooth the product list scrolls, and the time from clicking the shortcut to a
   usable POS. The benchmark cannot run on Windows, so a stopwatch and Settings > About & updates > Startup details are the tools.
