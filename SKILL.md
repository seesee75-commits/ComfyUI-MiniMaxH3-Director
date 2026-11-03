---
name: h3-director
description: Install, operate and troubleshoot the MiniMax H3 Director for ComfyUI (long videos with MiniMax H3, shots on a timeline, characters, voices, songs, storyboard, control videos). Use when a user wants to set up the H3 Director, run one of its example workflows, or is stuck with it.
---

# MiniMax H3 Director — skill for AI agents

The H3 Director is a ComfyUI node pack. It plans a video of any length as render parts of about ten seconds, renders
them with MiniMax H3 in ComfyUI's native loop and joins them into one video with sound. Read [GUIDE.md](GUIDE.md) for
what every node and field does; this file tells you how to install it, run it and help a user who is stuck.

Rules for you:

- Work through ComfyUI's own interface and the user's files. Never patch ComfyUI itself or other node packs.
- Ask before downloading models (they are large), before changing a user's workflow file and before deleting anything.
- Do not queue renders while the user's ComfyUI is busy (`GET /queue` empty first); a render takes minutes.

## 1 · Install

1. Install it with ComfyUI Manager ("MiniMax H3 Director"), or put the pack into `ComfyUI/custom_nodes/` — download the release zip from
   https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/releases and unpack it, or
   `git clone --branch v1.0.1 https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director`.
2. Install the dependency with **ComfyUI's** Python (portable build: `python_embeded\python.exe`):
   `python -m pip install -r requirements.txt`.
3. Restart ComfyUI and reload the browser with Ctrl+F5. ComfyUI must be **0.37.0 or newer**.
4. Check: the start log has no import error for the pack; `GET /object_info/NGH3Director` answers. The `h3-example-*`
   files reach the input folder when an example workflow is opened in the browser (not on start; existing files are never
   overwritten). Running an example through the API instead: first `POST /ng/example_media` with
   `{"names": ["h3-example-hero.jpg", …]}`.

## 2 · Models

`js/ng/models.json` lists every file with its folder, size and download URL; [GUIDE.md](GUIDE.md) chapter 2 has the same
table with links. Minimum for any workflow: the two H3 models (`models/diffusion_models`), the text encoder
(`models/text_encoders`, type `minimax`), video and audio VAE (`models/vae`) and `taeh3.safetensors`
(`models/vae_approx`). Turbo LoRAs go to `models/loras`.

To see what a running ComfyUI has: `GET /ng/models?purposes=all` — per file `auto` is the file found (null = missing).
In the UI: H3 Director → gear → **Models**, or ComfyUI's **Missing Models** panel when a workflow opens.
Files may sit in subfolders or have other names; then the user picks them in the loader node (or in Settings → Turbo
for the LoRAs).

## 3 · Run an example

1. ComfyUI → **Templates** → search "H3 Director" → open e.g. *H3 Director - 1 Text to video*.
2. Resolve the missing models (download, or choose the local file in each red loader).
3. Press **Generate** in the Director or ComfyUI's **Run**.
4. The video is saved in `output/H3/`. 15 s at 1280×704 with Turbo take about 15–20 minutes on a 16 GB card.

| Workflow | Use it for |
|---|---|
| 1 Text to video | first test, no pictures needed |
| 2 Characters and voice | a character from a picture, a voice from a sound file |
| 3 Music video | a singer to a locked song |
| 4 Shots from pictures | shots that start exactly on pictures |
| 5 Pictures | one picture per shot |
| 6 Storyboard | planning with a storyboard sheet |
| 7 Control video | movement from another video (pose, canny, depth) |
| 8 Inpaint | replacing a person in footage |
| 9 Custom sampling | own sampler nodes in the loop |

## 4 · Helping a user who is stuck

Ask for: the ComfyUI console output (the whole traceback), what the Director shows (warnings under Turbo, the notes
in **Prompts per render part**) and which workflow they started from. Then:

| Symptom | Cause and fix |
|---|---|
| Nodes missing or look broken | Pack not loaded or old browser cache: check the start log, restart ComfyUI, Ctrl+F5 |
| Red loader, "Missing Models" | File not found under that name: download it or choose the local file in the loader |
| "Turbo LoRA not installed: …" | Download the LoRA or choose another in Director → Settings → Turbo; or switch Turbo off |
| Prompt refused, `value_not_in_list` | A file name in a node is not in ComfyUI's list: pick an existing file in that node |
| Out of memory | Settings → Render part 5 s; the int8 video VAE; Resolution *Fast*; close other GPU programs |
| Figure looks different in later parts | Use References mode; add a character sheet (picture editor → Sheet); set *Belongs to* for extra views |
| The same figure appears twice | A second picture of the figure needs **Belongs to** that figure |
| Figure walks backwards / wrong direction | Say the direction in the shot text ("climbs up the stairs, facing the steps ahead") or try another seed |
| Words the user did not write are spoken | A voice sample with words reaches only parts where its figure speaks; check that no Text card or Prompt contains them |
| A song gets dull or out of sync | Audio card **Use as: Lock**, lyrics timed with Whisper |
| Visible jump at a join | Settings → Transition *Continue picture and sound*; avoid new actions right after a part edge (the Studio warns) |
| Control video does nothing | ModelPatchLoader with the ControlNet on the Connector's `model_patch`; the clip on the Director's Control lane |
| AI buttons grey | Connect an H3 AI Loader to the Connector; for Ollama start the server and pick a vision model (qwen3.5:9b tested) |
| Nodes overlap after loading a picture | Fixed in 1.0.0; update the pack |

Diagnose a failed run: `GET /history?max_items=1` shows `status.messages`; an `execution_error` names the node and the
message. Validation errors come back from `POST /prompt` as `node_errors`.

## 5 · Where things are

| What | Where |
|---|---|
| Guide (all chapters) | [GUIDE.md](GUIDE.md), `js/guide/en/*.md`, the **H3 Guide** node |
| How it works (planning, continuation, measurements) | [docs/paper/h3-director-technical-paper.md](docs/paper/h3-director-technical-paper.md) |
| Technical notes | `docs/NG*.md`; Legacy Director: `docs/legacy-director.md` |
| Example workflows and their files | `example_workflows/`, `example_media/` |
| Finished videos | `output/H3/`; kept render parts for resume: `output/h3-director-resume` |
| Tests | `python tests/ng/run_all.py` with ComfyUI's Python (no GPU) |
| Bugs | https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues |
