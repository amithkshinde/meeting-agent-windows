# Meeting Agent for Windows

A small floating window for your PC that notices when you join a call, records the screen and the sound, writes the
transcript, summarises it, and keeps track of what everyone promised.

Free and open source (MIT). Works in English and Hindi. You bring your own free Google Gemini key, so there is no
subscription.

> **Status: first version, not yet tested on a real Windows PC.**
> The logic is covered by 10 automated tests, and they pass. The recording and screen-capture code has been written
> but not yet run on real hardware, so expect a few rough edges on the first run. If something breaks, please
> [open an issue](../../issues/new) and paste the error.

Looking for the Mac version? See **[meeting-agent-mac](https://github.com/amithkshinde/meeting-agent-mac)**.

---

## Contents

1. [What it does](#what-it-does)
2. [Install and run](#install-and-run)
3. [Set up the AI key](#set-up-the-ai-key)
4. [Using it](#using-it)
5. [What works, compared with the Mac version](#what-works-compared-with-the-mac-version)
6. [Where your files are saved](#where-your-files-are-saved)
7. [Privacy and consent](#privacy-and-consent)
8. [Troubleshooting](#troubleshooting)
9. [Feedback](#feedback)
10. [For developers](#for-developers)
11. [Known limits and next steps](#known-limits-and-next-steps)
12. [License](#license)

---

## What it does

1. **Notices the call.** It watches for Google Meet, Zoom and Teams windows, so you do not have to remember to start.
2. **Records.** Your screen, the sound of the other people, and your microphone, saved as three files per call.
3. **Writes it up.** After the call you get a transcript, a summary, the decisions made, and who promised what.
4. **Lets you find it again.** Search across every call, jump to any moment by clicking a transcript line, and mark
   highlights as you go.

---

## Install and run

You need a Windows 10 or 11 PC. There are two ways to get the app.

### Option A: run it from source (works today)

1. Install **Node.js** (the LTS version) from <https://nodejs.org>. Accept the defaults.
2. Download this repository: click the green **Code** button, then **Download ZIP**, and unzip it.
3. Double-click **Run Meeting Agent.bat**.
   The first time it installs what it needs, which takes a few minutes. After that the app opens.

### Option B: build an installer you can share

- **On a Windows PC:** double-click **Build Windows Installer.bat**. The installer appears in the `dist-installer`
  folder as `MeetingAgent-Setup-<version>-x64.exe`. Send that one file to anyone.
- **Without a Windows PC:** let GitHub build it for you.
  1. Open the **Actions** tab of this repository.
  2. Choose **Build Windows installer**, then **Run workflow**.
  3. When the run finishes, download **MeetingAgent-Windows** from the bottom of the run page. It contains the `.exe`.

### The "Windows protected your PC" warning

The first time you open the installer, Windows warns you because the app is not code-signed. Click **More info**,
then **Run anyway**. A signing certificate would remove the warning, but it costs money every year.

---

## Set up the AI key

Transcripts and summaries need a key from Google Gemini, which has a free plan.

1. Open <https://aistudio.google.com/apikey> and create a key.
2. In the app, open **Settings** and paste the key.

The key is stored encrypted by Windows and never leaves your PC except to talk to Google.

- A Claude key (it starts with `sk-ant-`) also works for summaries, but **Claude cannot listen to audio**, so
  transcripts still need a Gemini key.
- The free Gemini plan allows about 20 requests a day. Each call uses three, so expect roughly six calls a day.

---

## Using it

- Join a call. The floating window offers to record. You can also press **Ctrl+Shift+R** at any time.
- Press **Ctrl+Shift+B** to mark an important moment while you talk.
- Press **Ctrl+K** to search every call, everything that was said, and every promise.
- The tray icon (bottom right of the taskbar) opens the main window with all your calls.
- Choose your language in **Settings**. English and Hindi are supported.

| Shortcut | What it does |
|---|---|
| Ctrl+Shift+R | Start or stop recording |
| Ctrl+Shift+B | Mark a moment |
| Ctrl+K | Search everything |

---

## What works, compared with the Mac version

| Feature | Windows | Notes |
|---|---|---|
| Notices Google Meet, Zoom and Teams calls | Yes | Reads window titles. Meet only counts while its tab is in front. Teams is best effort. |
| Floating window, tray icon, hotkeys | Yes | |
| Records screen, the other people, and your mic | Yes | 10 frames a second, up to 1080p, as three files per call. |
| Transcript | After the call | Not live yet. About a minute for a 30-minute call. |
| Summary, decisions, promises | Yes | Same idea as the Mac app. |
| Click a transcript line to jump the video | Yes | The video is repaired after recording so jumping works. |
| Highlights (marked moments) | Yes | |
| Search everything | Yes | Calls, what was said, and promises. |
| Export | Markdown | PDF, Reminders and Notion are not built yet. |
| Hindi and Hinglish | Yes, untested | |
| Feedback page, with an anonymous option | Yes | |
| Speaker names from the video | **No** | Speakers appear as "Speaker 1, 2…", and you can rename them. |
| Design review (screens grouped) | **No** | |
| Live suggestions during the call | **No** | |
| Per-project memory and chat over everything | **No** | Calls can be tagged with a project. |

---

## Where your files are saved

In `Videos\MeetingAgent`, one folder per call:

| File | What it is |
|---|---|
| `screen.webm` | The screen recording |
| `system.webm` | The sound of the other people |
| `mic.webm` | Your microphone |
| `transcript.txt` | The transcript |
| `call.json` | Summary, decisions, promises, highlights |

---

## Privacy and consent

- Video and audio files stay on your PC.
- Only the **audio** (to make the transcript) and the **text** (to make the summary) are sent to the AI service you chose.
- **Tell people you are recording.** The law on recording calls differs by country, state and company. Always get
  consent from the other participants before you record.

---

## Troubleshooting

| Problem | What to try |
|---|---|
| The `.bat` window says Node.js is not installed | Install the LTS version from <https://nodejs.org>, then double-click the file again. |
| "Windows protected your PC" | Click **More info**, then **Run anyway**. See above. |
| No transcript appears | Check the Gemini key in **Settings**. If you made many calls today, the free daily limit may be used up. |
| The call is not noticed | For Meet, keep its tab in front. Or press **Ctrl+Shift+R** to start by hand. |

If none of that helps, [open an issue](../../issues/new) with what you did and any error text.

---

## Feedback

Open **Feedback** in the app's sidebar. You can add your name and email if you would like a reply, or stay anonymous.
An anonymous message never carries a name or email.

You can also [open an issue](../../issues/new) here on GitHub with a bug report or an idea.

If you **fork** this project and make it better, please let the author know, so he can see what you changed and learn
from it.

---

## For developers

    npm install       # once
    npm start         # builds and runs
    npm test          # 10 tests for the logic
    npm run dist      # builds the Windows installer (x64)

| Folder | What is in it |
|---|---|
| `src/main` | The app's engine (Electron main process): windows, call detection, recording files, AI, saving. |
| `src/renderer` | The screens (floating window and main window), plain TypeScript with no framework. |
| `src/shared` | Logic with no Windows or Electron dependency. This is what the tests cover. |
| `build` | The app icon. |
| `scripts` | Small build helpers. |

**Feedback settings.** The app reads optional settings from `package.json` under `meetingAgent`:
`feedbackEmail` (where the email option sends feedback) and `feedbackEndpoint` (an online form address).
Both are empty in this public repository. With both empty, feedback goes to GitHub issues. If you build your own
copy and want feedback by email, set `feedbackEmail` in your local build only, and do not commit it.

---

## Known limits and next steps

- Not tested on a real PC yet. First job: run it, join a call, and report what breaks.
- Transcript quality and the 20-requests-a-day free limit depend on Gemini. A local engine (whisper.cpp) would remove both.
- Detection by window title misses a Meet tab that is behind another tab. Watching which app is using the
  microphone would fix that.
- Next ports from the Mac app: live captions, speaker names from video, design review, PDF export, Reminders and Notion.

---

## License

MIT. Copyright (c) 2026 Amith K Shinde. See [`LICENSE`](LICENSE).
