# Changelog

## Unreleased

- **An image in the middle of the window is sent where it sits.** H3 gives the first and the
  last frame a slot of its own, and for a long time that was the whole story: anything between
  them had no position to be sent at, so it was counted in the warnings and dropped. A
  three-beat timeline handed the model its opening and its closing frame and nothing in
  between, and the only way to use the rest was to turn them into `<Picture i>` references,
  which describe an image without placing it.

  ComfyUI 0.34.0 added a node that conditions a guide at an arbitrary frame, and one is now
  chained per stranded image, at the frame the timeline puts it on. A timeline video anchors as
  a clip rather than a single frame — H3 takes 5, 22 or 39 frames, so the segment is cut to the
  longest of those that fits, and stops at 39 because a guide latent is re-injected at every
  sampling step. The canvas badges each one with the second it lands at, in the model's 24 fps
  rather than the timeline's, since that is the number the two clocks disagree about.

  Not a word of the prompt changes: where an image is anchored is a fact about the
  conditioning, and the storyboard is written from the timeline either way.

  On a ComfyUI older than 0.34.0 the node does not exist, the images are ignored as they were
  before, and the warning names the version that adds it — in the live preview as well as in
  the log, so the panel never promises an anchor the render will drop.

- **The audio track guides the model, and not only the mixdown.** With **Use audio track** on
  and `minimax_h3_audio_vae` connected, a clip inside the window is conditioned from the second
  it starts as well as being mixed into `combined_audio`, which is what a line of dialogue
  needs to land on the mouth that speaks it. Without the audio VAE the clip is mixed and not
  sent, with a line saying which input is missing; with Override Audio the track is not the
  soundtrack and is not a guide either, the way it already was not a reference. A clip set to
  **lock** is held in the audio stream instead and is not a guide.

## 0.3.2

**A voice on the subject, not on the timeline** (issue #10). Every subject slot has an
**Add voice** button (Refs ON), or drop an audio file on the slot. That clip is sent to the model
as an `<Audio N>` reference tied to *that* subject:

```
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).
<Audio 2> is the voice-timbre reference for <Subject 2> (S2).
```

It is not on the timeline, so it is not bounded by the render window and takes no output time —
two voice references and a background track no longer compete for one lane, and the render stays
as short as you made it. It does not depend on the audio-track switch either: a voice on a subject
is as deliberate as the subject's image. Voices go first in `<Audio N>` order (slot order), then
whatever sits on the timeline, inside H3's cap of three audio clips; a clip that does not fit is
named. The timeline's audio clips and their **Voice of** menu work as before. A slot with no
reference image cannot be a `<Subject N>`, so its voice goes out as a plain voice reference, which
the tooltip says. Override Audio together with a reference video still wins (a reference video's
soundtrack is numbered first), and it names the voice it set aside. The log warns when a voice file
is under the 2 s the model card asks for.

## 0.3.1

[@Brioch](https://github.com/Brioch)'s pull request [#18], carried over by hand: it had stopped
merging after 0.2.3–0.3.0 touched the same planner and docs, so its behaviour was re-implemented
on the current code and its tests re-written against it. Every idea below is theirs.

- **A reference no longer spends output time.** A reference is an input to the model, not content
  in the video — `<Video k>` and `<Audio j>` are never composited — but a clip had to overlap the
  render window to be sent at all, and adding one stretched the window to cover it. The model card
  wants each reference audio clip 10–15 s long, so three of them grew the output to 45 s: three
  times the longest video H3 can make. Neither reference track touches the output length now,
  and a clip is sent from wherever it sits; it lands after the last one, which for anything
  longer than the window is out in the shaded area, where a reference belongs. A 5 s render
  sends all three. Position still decides one thing, for audio only: whether the clip is *also*
  part of the muxed soundtrack — inside the window it is both, past it a reference only, which
  the clip's info panel says. A parked reference video is sent whole on its own trim instead of
  losing its head to a window start it has nothing to do with. A **retake** keeps the old rule.
  (`lock` clips are not references and still have to be in the window: a lock is a position in time.)
- **Every audio clip on the track plays its own file again.** With two clips loaded both showed
  up in the prompt and both drew their waveform, but only one could be heard: the editor stamped
  the decoded buffer onto every clip that matched it, and a standalone clip has no blob URL to
  match on, so the test was `undefined === undefined` for the whole track. Only the preview was
  affected; what was sent to the model was always right.
- **A reference clip that cannot be read says which one.** A missing file or a trim past the end of
  the audio was dropped in silence — and because `<Audio N>` is numbered before any file is opened,
  that label and every one after it then named a reference the model never got. The log now names
  the clip and its label.
- **Both per-type caps (3 audio, 3 video) name the clip they drop**, like every other limit.
- **Override Audio wins over the audio track outside the editor too**: sent together, every
  `<Audio N>` label would be one off (a reference video's soundtrack is numbered first). The clips
  set aside are named, and Override Audio warns when the video it wants the soundtrack from is
  parked past the window.

[#18]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/pull/18

## 0.3.0

Your own audio in the video, with a way to choose how — and the lines the model needs to believe it.

- **A clip set to `fully_copy` / `partially_copy` now has a real chance of being copied.** Setting
  the marker was always possible (right-click a clip) and it wrote the guide's
  `retention_analysis` line — but with `non_diegetic_music: N/A` and no soundscape line the
  model sang something of its own. Measured on an 8 s singing clip, 20 steps: without the two
  sound lines the audio was unrelated to the clip in all three runs (envelope correlation
  0.08–0.17); with them the clip itself came back in four runs of six (0.96–0.98) and not in
  the other two (0.10, 0.21), the same prompt on a different seed. So it is the guide's
  behaviour and the model follows it most of the time, not always. The Director now writes
  those two lines whenever a clip is set to a copy marker and the boxes are empty, in the
  guide's own wording ("`<Audio 1>` is directly reused as the complete audience-only score");
  text you write there still wins. The default stays `reference`, which follows a voice or
  style and never copies. **For audio that must come out as given, use `lock`.**
- **New: `lock (exact audio)` on an audio clip.** Not a prompt wording but a different
  mechanism, the one the LTX Director used: the clip is encoded with the audio VAE into the
  model's audio stream and held there with a zero noise mask, and the video is generated around
  it. The gaps between locked clips, and anything after the last, stay the model's. It works with
  Refs OFF too, where the guide offers no audio references at all. Measured at 0.99 in every
  run (five of five, both checkpoints), against four of six for the copy markers. A
  locked clip is not an `<Audio N>` reference, gets no label and does not count against the
  limit of three. It needs the audio VAE and says so if it is missing.
- **Only one `fully_copy`.** The marker means "the complete final audio track"; a second clip
  with it is written as `partially_copy` and the warnings area says so.
- The right-click menu now calls the audio setting **Audio use** and lists `lock` beside the
  guide's four markers; with Refs OFF it offers `mixdown only` / `lock`.
- README: a table of what each setting does to the sound, and what was measured.

## 0.2.5

- **The node now says when a timeline audio clip is not being sent to the model.** With
  References off (fl2va) the model has no audio input at all, and with the audio track
  switched off in ref2va nothing is sent either; in both cases the clip is carried only by the
  `combined_audio` output. That is how it was designed, but it looked exactly like a clip
  that was ignored: the voice in the result was the model's own, spoken from the text, and
  nothing said why. The warning names which case it is and what to do — wire `combined_audio`
  into CreateVideo to hear the clip itself, or use Refs ON with the audio track enabled so
  the model gets it as an `<Audio>` reference. Even then it is a reference the voice follows,
  not a copy of the waveform.

## 0.2.4

- **`prepend_text` on the Director** ([#29]). A connection-only text input; whatever is wired
  into it goes in front of the global prompt, joined by a comma. It was asked for so LoRA
  trigger words can come straight from a LoRA loader. It is deliberately **not** put ahead of
  the whole compiled prompt: the minimax format opens with the task statement and labelled
  sections, and text in front of them would break the shape both guides ask for. The
  Director's existing `prompt` output carries it, so a second pass can reuse the composed
  text (the other half of the request, which already worked). The panel's live preview cannot
  show it, because the text does not exist until the graph runs. The new socket is declared
  last, so workflows saved before it keep every value where it was.

## 0.2.3

Three bugs reported by users, and one control that never did anything.

- **Save / Save As kept only part of the timeline** ([#23], reported and diagnosed by
  [@SveSop](https://github.com/SveSop)). The Director stores its timeline from an allowlist,
  and the `.json` written by Save carried its own, shorter copy of it. `overall_soundscape`,
  `non_diegetic_music` and the hand-written prompt override (`prompt_override`,
  `prompt_override_on`) were on the first list and not the second, so they came back empty
  after a Load — no error anywhere. The two lists now match, and `test_node.py` compares them
  by key name so the next field added to one cannot drift from the other.
- **Retake Stitch could not find the base video's audio** when the input folder is not the
  default one ([#30], reported with the fix by [@Jaminblack](https://github.com/Jaminblack)).
  The frames were fetched through the media library, which resolves the timeline's relative
  filename against the input folder; the soundtrack was handed to PyAV as-is and looked for
  `whatdreamscost/…` in the working directory. The head and tail of the result came back
  silent and the log said `could not read audio`. The audio slice resolves the name the same
  way now, and says plainly when the file is not in the input folder.
- **A base URL ending in `/v1` no longer produces a 404** ([#31]). The Analyze request
  appended `/v1/chat/completions` to whatever was typed, so the address Anthropic's and LM
  Studio's docs give — `https://api.anthropic.com/v1/` — asked for `/v1/v1/chat/completions`.
  Both spellings work now, and the tooltip and README no longer say "no path".
- **Video Strength and Video Attn are gone from reference-video segments** ([#26]). They are
  LTX conditioning weights inherited from the editor this one was forked from; nothing in the
  H3 planner reads them, so moving them changed no output at all. The stored values stay in
  old timelines and are ignored, as before.

[#29]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/29
[#23]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/23
[#26]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/26
[#30]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/30
[#31]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/31

## 0.2.2

Two contributions from [@Brioch](https://github.com/Brioch) — [#16] and [#17], closing
[#20] and [#19] — and a new node.

- **New node: MiniMax H3 Save Last Frame.** It goes straight after `VAEDecode`, writes the
  last frame of the batch as a PNG the way Save Image would — same counter, same
  `%date:…%` tokens, same embedded workflow metadata — and passes the batch on. Every H3
  render ends on a frame worth keeping, since it is the one you feed back in as the next
  shot's opening keyframe, and fishing it out otherwise meant a second graph with
  `ImageFromBatch` wired to a `SaveImage`, rebuilt every time the length changed.

  Two things it deliberately does not do. It never touches the pixels: the IMAGE output is
  the same tensor object that came in, so it cannot change what anything downstream decodes
  or muxes. And it does not need to be bypassed — `save` is a widget, because a node that
  has to be disabled between runs is a node that will be left enabled by accident.

- **The resolution panel covers every aspect ratio the model card lists, in both
  orientations.** Six presets reached 16:9, 9:16 and 1:1; 21:9, 4:3 and 3:4 are in MiniMax's
  own output envelope and had to be worked out by hand — from an area cap, in multiples of
  32 — and typed into Width and Height. There are 26, at two sizes:

  | Ratio | Native | Fast |
  |---|---|---|
  | 21:9 | 1344×576 | 1120×480 |
  | 2:1 | 1344×672 | 960×480 |
  | 16:9 | 1344×768 | 864×480 |
  | 3:2 | 1152×768 | 736×480 |
  | 4:3 | 1024×768 | 640×480 |
  | 5:4 | 960×768 | 608×480 |
  | 1:1 | 992×992 | 640×640 |
  | 4:5 | 768×960 | 480×608 |
  | 3:4 | 768×1024 | 480×640 |
  | 2:3 | 768×1152 | 480×736 |
  | 9:16 | 768×1344 | 480×864 |
  | 1:2 | 672×1344 | 480×960 |
  | 9:21 | 576×1344 | 480×1120 |

  **Native** keeps H3's 768 px short edge, and holds the long edge at 1344 for the two
  widest ratios, letting the short edge give way instead. That 1344 is the table's own
  ceiling rather than a rule of the model's — H3's policy is a 768 short edge plus an
  **area** cap of 768×1344, so at 21:9 `adapt_canvas` itself returns 1536×672 and the
  preset's 1344×576 spends a quarter less canvas than it is allowed. That is the intended
  trade: a preset should be the safe answer, and **Aspect / MP** is there for the whole
  budget at a wide ratio.

  **Fast** is the same list at a 480 px short edge, 1:1 aside, which stays area-matched to
  its tier rather than dropping to 480×480. Every edge is a multiple of 32 — H3's own step,
  and what `divisible_by` defaults to — so a preset is never quietly floored to something
  else on the way in.

  0.2.1's `1920×1088` is still there, under a **Past native** heading of its own, since it
  is the one canvas here that leaves the trained envelope and the heading is what says so.
  Everything above it is inside the envelope, so the list no longer mixes the two.

- **Or name a shape and a pixel budget instead of a canvas.** A new **Aspect / MP** row
  takes an aspect ratio and a figure in megapixels and fills Width and Height with the best
  pair of /32 edges that holds the ratio. Holding the ratio outweighs hitting the budget
  exactly, and overshooting the budget is penalised twice as hard as undershooting it, since
  memory is what a budget is protecting: 16:9 at 1.03 MP lands on H3's own 1344×768 rather
  than the 1376×768 that is closer to true 16:9 and 2.6% more canvas. Either box works on
  its own — a budget with no ratio picked rescales the shape already in the boxes — and
  typing Width and Height by hand still works, with both menus following along and reading
  `—` for a shape the ratio list does not name.

- **A timeline image no longer collapses the canvas to one pixel.** `resize_image`'s
  cover-crop sized the scaled image with `int(W * ratio)`, and a ratio that is exact in
  arithmetic comes back a hair under its integer in floating point — `704 * (480 / 704)` is
  `479.99999999999994`. The cover then landed one pixel short of the canvas, the centre slice
  started at −1, and a 1px-wide image came out: a 704×1408 timeline image fitted to 480×640
  hit the Director's canvas guard as *"the canvas came out 1x640"*, naming a width nothing had
  asked for. Roughly one source width in nine does this at a 480 px canvas, and the crop is
  the default fit, so it was reachable from any preset. Rounding rather than truncating — and
  requiring a cover to be at least the size of what it covers — makes it unreachable.

  The same truncation was quietly costing a whole 32-block in the aspect-preserving methods,
  where nothing crashed and so nobody looked: **maintain aspect ratio** fitted a 1920×1080
  image into a 1024×1024 box at 992×544 rather than the 1024×576 the code's own docstring
  promises.

- **A voice reference's declaration ends on the speaker's global ID**, which is what the
  guide means by "reuse that speaker's global ID in the definition":

  ```
  subject_definitions:  <Audio 1> is the voice-timbre reference for <Subject 2> (S2).
  ```

  The ID is the speaking order rather than the subject number, so it cannot be known when
  that sentence is written — it is filled in once the numbering pass has walked the finished
  body. A subject who never speaks has no ID to reuse and the sentence ends on the label,
  which already says whose voice the clip is. A hand-written declaration gets the same
  treatment when it names the subject, and is left alone when it writes an ID of its own.

- **A spoken line stays where it was written.** Dialogue is lifted out of a shot prompt to be
  rendered and was then appended to the end of the shot, which only looked right when the
  line already came last. A line with prose after it moved:

  ```
  @ref1: before mid segment          [Shot 1] mid segment. a woman (S1) says,
  mid segment                    →     <d>[English] before mid segment</d> a woman (S1)
  @ref1: after mid segment             says, <d>[English] after mid segment</d>
  ```

  It is now put back where it sat, which is how the guide writes a shot — its own Shot 1 goes
  action, the line that action motivates, then more action. The same pass decides both
  orderings the guide cares about, so they can no longer disagree: which mention of a subject
  is its *first* — and so is named in full rather than by its **called** name — and the order
  of vocal events that hands out `(Sx)`. A frame anchor still rides with the prose rather than
  trailing the shot, since a spoken line is not something a shot "begins from". `</d>` no
  longer picks up a full stop it never needed.

- **The live preview reports a line that reads as dialogue and stayed prose.** The colon is
  what makes a tagged line dialogue, and `@ref1 says "hello sir"` — the natural thing to
  type — has none, so it reached the model as narration: no speaker ID, no `<d>[Language]
  …</d>`, and nothing for an `<Audio N>` voice reference to reuse. The line is not
  reinterpreted, because prose quotes things nobody says out loud, but it is no longer
  silent:

  ```
  [Shot 2] `@ref1 says "hello sir"` reads as dialogue but has no colon, so it stayed
  narration — no speaker ID, no <d>[Language] …</d>. Dialogue is `@ref1 <how it is said>:
  the words`.
  ```

  `@char1 says: hello` is reported the same way: the alias resolves to a subject label
  everywhere, but only `@refN` speaks.

- **Two required fields are reported when they are empty.** `detailed_description` joins
  `overall_soundscape`, which was already checked — and unlike the soundscape it has no
  `N/A`, so an empty one leaves the section out of the prompt entirely rather than visibly
  blank. A voice reference bound to a subject who never speaks is reported too, naming the
  tag that would give them a line: the declaration has no `(Sx)` to reuse in that case, which
  is correct and reads like a bug.

[#16]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/pull/16
[#17]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/pull/17
[#19]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/19
[#20]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/20

## 0.2.1

Four reports, and one of them was right about something this pack had been saying wrongly
since 0.1.0.

- **`width` and `height` can be wired in** ([#14]). The settings panel owns
  `custom_width` / `custom_height` and hides them, and a hidden widget's input slot is
  never laid out — LiteGraph left it at the node's own origin, so five invisible sockets
  sat stacked under the title bar. There was no reachable way to drive the canvas from a
  resolution node. There are now two connection-only inputs beside `start` / `end` /
  `duration`, and the five orphaned slots are dropped when nothing is wired to them (a
  link saved in an older workflow keeps its socket).

  A wire carries no minimum where a widget does, so `0` — what an upstream node hands over
  when its own value was never set — is refused by name rather than passed into the VAE,
  the same guard `duration` grew in 0.1.2.

- **A subject description reaches the ComfyUI prompt format** ([#14]). That format resolves
  `@ref1` to the bare `<Picture 1>` and has no `subject_definitions` section, so a
  description typed into a slot had nowhere to go and was simply dropped: the prompt said
  "`<Picture 1>` steps out of the doorway" and never once said who that is. It now goes
  into the flat `Reference notes:` line, subjects before pictures, so the thing is
  introduced before the frame that shows it. The MiniMax format is unchanged — it has had
  the section all along, and started *using* the description in 0.2.0.

- **An API key for a cloud vision model** ([#15]). Nothing here ever sent an
  `Authorization` header, so the `Custom (OpenAI-compatible)` provider could only reach a
  server that did not ask for one. Both the Analyze button and the Enhance node send a
  bearer token now, and a 401 says where to put the key instead of echoing the endpoint's
  own body.

  Where the key is kept mattered more than sending it. The Analyze settings live in
  `timeline_data`, which is serialised into the workflow JSON — a key typed there would
  travel with every workflow you share. So the gear menu's field writes to **ComfyUI's user
  settings** instead, and the Enhance node's widget takes the **name of an environment
  variable** rather than a key, because widget values *are* saved with the workflow.
  Failing that: `MINIMAX_DIRECTOR_VLM_API_KEY`, then `OPENAI_API_KEY`.

- **4–15 seconds is the trained range, not a limit** ([#12]). Nothing in this pack ever
  capped the length, but the README said "H3's trained range is the limit" and the console
  warned of "a VRAM wall" — which nobody here had measured, and which a 45-second render on
  a 5090 contradicts. Both now say what is actually true: it renders, quality leaves the
  envelope the model card describes, and the clock climbs faster than the video does
  because attention cost goes with the square of the sequence while memory goes with its
  length.

- **The `2K` resolution preset is labelled `past native`** ([#14]). The model card's 2K is
  not these weights at 1920×1088 — it is `H3-Regenerate-2K`, a separate in-context
  regeneration pass, and MiniMax says "this module is not yet open-sourced. We will release
  it once it is ready." The preset still exists; it no longer claims to be something it is
  not.

- **New offline test file, `test_node.py`** — 35 checks for the parts that need ComfyUI
  imported, which `test_plan.py` deliberately cannot reach: the automation-socket guards,
  API-key resolution, and a check that every schema input has a matching `execute()`
  parameter. `test_plan.py` is up to 270.

[#12]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/12
[#14]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/14
[#15]: https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/15

## 0.2.0

Full-reference mode, from
[`references/ref-en.txt`](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt).
Until now a reference image was always a character, always followed as tightly as
possible, and a timeline image was always a frame anchor. The guide describes far more
than that, and two of its sections were structurally missing from the output.

- **A reference no longer has to be a character.** The guide defines `<Subject N>` as
  "people, animals, or objects; scenes, backgrounds, or environments; clothing, props,
  interfaces, or visual effects; styles, actions, expressions, or poses". Each slot now
  carries a **kind** that supplies the noun when no description is written, so a slot can
  hold a location or a look instead of a face. The panel goes from three slots to nine,
  and `@ref1` … `@ref9` address them. `@char1` … `@char3` still resolve.

- **A subject no longer has to have an image**, which is what made subjects unreachable on
  the **Refs OFF (fl2va)** path: the slot's text boxes only appeared once something had
  been dropped on it, and fl2va discards the drop. The one thing that path can carry was
  behind the one thing it throws away.

  [`references/base-en.txt`](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)
  has no `subject_definitions` section at all — with no reference files there is nothing to
  declare — so a subject there lives in the prose, "established when a speaker first
  appears" and referred to consistently afterwards. The slot now says both halves of that:

  | Box | Becomes |
  |---|---|
  | **describes** | the full identity, written where the subject first appears |
  | **called** | what to call it at every mention after that |

  ```
  @ref1 places a fresh loaf on the counter.
  @ref1 says: First batch of the morning.

  → [Shot 1] a middle-aged baker with a calm, slightly raspy voice places a fresh loaf on
    the counter. the baker (S1) says, <d>[English] First batch of the morning.</d>
  ```

  Tags now resolve left to right through the finished video — the global block, then each
  shot in turn, its prose before its dialogue — so "first" means first on screen and not
  first in whichever box is being scanned. A subject introduced by its own spoken line is
  named in full there. An empty **called** repeats the description at every mention, which
  is what every timeline written before this field did. The same treatment applies with
  references *on* to a slot that has a description but no image: no picture, no
  `<Subject 1>` to lean on, so the prose has to carry the identity.

  Images left in a slot with references off are kept — switching the toolbar back must not
  cost the upload — but they are dimmed, and the prompt panel now says outright that
  fl2va sends none of them.

- **The fl2va prompt now stops at the fields the base guide defines.** Its structure is
  closed — the alignment instruction, then "Three Core Fields (Required, in this order)" —
  and `summary` is not among them; it belongs to the reference guide. A filled summary box
  was emitting a section H3 was never trained to read on that path, task-type prefix and
  all. The box is now hidden with references off and keeps its text for when the toolbar
  goes back.

  The other half of "required" also applies: `non_diegetic_music` is written as `N/A` when
  the box is empty, which is the value both guides use for having none.
  `overall_soundscape` deliberately does **not** get filled in the same way — there `N/A`
  means the video was asked to be silent, which is a claim only you can make — so an empty
  one is called out in the prompt panel instead. H3 generates the audio; leaving that field
  out hands the whole soundtrack to a guess.

  The 350-500 word figure is the reference guide's, for its own `detailed_description`.
  The base guide gives no word count, so the fl2va path no longer cites one. The word
  figure is still reported either way.

- **A reference no longer has to be followed exactly.** Every reference carries one of the
  guide's four **retention markers**, written into `retention_analysis` verbatim because
  the guide calls them "fixed English values in the output format":

  | Marker | Meaning |
  |---|---|
  | `fully_preserved` | The defined role of the referenced content is fully preserved |
  | `partially_preserved` | Still used, some defined characteristics changed |
  | `attribute_transfer` | Its characteristics move to a different target subject |
  | `weak_reference` | Broad similarity in style, category, composition or atmosphere only |

  Audio uses its own set — `fully_copy`, `partially_copy`, `reference`, `weak_reference` —
  because copying a signal and imitating one are different jobs. An off-spec value coming
  from an edited timeline is clamped rather than passed through into the prompt.

- **Both sentences about a reference are yours to write.** The guide's lines name actual
  features rather than stock phrases — `fully_preserved - the Samoyed's thick white fur,
  pointed ears, dark nose, and curved tail are retained` — and name relationships the
  timeline cannot work out, like `<Video 1> is the source video for the target video edit`.
  Every reference therefore has up to two boxes, one per section it feeds:

  | Box | Becomes |
  |---|---|
  | **describes** | the reference's line in `subject_definitions` — what it *is* |
  | **retained** | the sentence after the marker in `retention_analysis` — what *survives* |

  Subject slots carry both in the panel; timeline images, reference videos and audio clips
  carry theirs in the properties panel. Either left empty falls back to the generated
  sentence, so the boxes override and never oblige. Frame and storyboard anchors are the
  one exception with no **describes** box: their declaration states where the image sits in
  the video, which the timeline already knows and should not be contradicted.

- **An image only gets a `<Picture N>` entry when it really is one.** The guide: "If an
  image is used only to define a character, scene, costume, or style, do not create a
  standalone picture entry. Instead, cite the image source inside the corresponding
  `<Subject N>` definition." A timeline image can now be a **frame anchor** (unchanged),
  a **storyboard** reference, or **subject-defining** — the last getting no picture entry
  and, because it is no longer a keyframe, no longer cropped to the output canvas either.

- **`subject_definitions` declares every label; `retention_analysis` scores every label.**
  Both sections were previously incomplete: pictures were never declared, and retention
  was prose. The two sections now follow the guide's shapes, and a subject's
  `(appears in [Shot 1], [Shot 3])` is read back off the shot text rather than assumed.

  Both are written one entry per line, the way the guide lays them out. They are lists of
  records rather than prose, and running a dozen of them together into a paragraph made it
  genuinely hard to see where one label ended and the next began.

  ```
  0.1.5   subject_definitions: <Subject 1> is the character shown in <Picture 1>.
          retention_analysis: Keep the identity, face and clothing of <Subject 1>
                              consistent across every shot. [Shot 1] begins from <Picture 2>.

  0.2.0   subject_definitions:
          <Subject 1> is a woman in a red coat, shown in <Picture 1>.
          <Picture 2> is the first frame of [Shot 1].

          retention_analysis:
          <Subject 1> (appears in [Shot 1]): fully_preserved - the collar shape and the
            silver necklace are retained.
          <Picture 2> ([Shot 1] first frame): fully_preserved - the framing and
            composition of <Picture 2> are retained.
  ```

- **New `summary` section with a derived `[task type]` prefix** — `keyframe completion`,
  `reference generation`, `audio reuse`, `audio reference`, combined with ` + ` in the
  guide's own order. It is derived from what the references are *used for*, not from what
  is connected: the guide warns that "the mere presence of video or audio does not
  automatically create a corresponding task type", so a reference video supplying only
  camera movement stays `reference generation`. The gear menu's **Task Type** field
  overrides it, which is the only way to reach `video editing` and `video continuation` —
  neither of which this node can produce on its own.

- Frame anchors are also named inside their shot, as the guide's section 5.3 asks:
  `[Shot 1] she enters. The shot begins from <Picture 2>.` The phrase goes after the
  shot's own text, because a later shot opens `At 00:05.000, ` and a capitalised clause
  cannot continue out of that comma.

- **The reference panel resizes, and the images grow with it.** The previews were locked to
  52px inside a fixed 148px slot — too small to judge a reference by, and with no room for
  a second text box. The panel now has the same drag strip the prompt and global-prompt
  panels have, its height is remembered per node, and the previews row is the only part
  that flexes, so every pixel gained goes to the image rather than to the text.

- **`overall_soundscape`, `non_diegetic_music` and the new `summary` box sit beside the
  global prompt, not on top of it.** The strip was absolutely positioned over the textarea,
  which was shortened by a hard-coded `calc()` to compensate — so the two fought over the
  same space and the strip sat on the box's own border. As a flex sibling the panel divides
  itself, with no second copy of the height to keep in step.

- **Analyze no longer assumes every slot is a character.** Its prompt said "describe the
  character's physical appearance", which produced what you would expect when the image was
  a coffee shop. It now asks about the slot's actual kind — a place, a garment, a pose —
  and returns the description and the retained sentence together. A model that ignores the
  two-line format still works: everything falls back to the description, and a note written
  by hand is never overwritten.

- **Speakers and dialogue.** The guide gives speakers stable `(Sx)` IDs "according to the
  order of actual vocal events in the target video" and wraps their lines in
  `<d>[Language] …</d>`. Neither existed here. A line that starts with a reference tag and
  contains a colon is now dialogue — the same "only at the start of a line" rule the
  `Audio:` / `Music:` lines already follow:

  ```
  @ref1 exclaims with light annoyance: Hey! Watch your dog!
  →  <Subject 1> (S1) exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d>
  ```

  The clause between tag and colon is the delivery, kept verbatim — the guide's example
  carries the performance there, and a generated "says" would throw it away. IDs are never
  written by hand: they are assigned in vocal-event order, reused by the same speaker at
  every later line, and kept out of `retention_analysis`, which the guide forbids.
  `@voice(a low male narrator)` covers a speaker with no panel slot, keyed on the
  description so repeats keep one ID. `@audio2:` names a line carried by a reused track and
  gets no ID at all, since a cue inside a soundtrack has no independent vocal source.

  A shot whose only content is a spoken line is still a numbered shot — testing the prompt
  alone would have dropped it once the dialogue was lifted out, losing the line and
  shifting every later shot number, including the ones picture notes point at.

- **The live preview reports a speaker ID written into a retention note**, which the guide
  forbids outright, and **shows `detailed_description`'s word count in its badge** against
  the guide's suggested 350–500 for generation tasks. The count is a figure rather than a
  warning: 350 words is a lot for a 5–15 second clip, so sitting under it is the ordinary
  state here, and warning about it fired on essentially every timeline — which is how a
  warnings area stops being read at all. Only overshooting the range is called out.

- **Reference videos can be turned down when they run you out of memory.** Their frames are
  VAE-encoded whole and the latents ride through every sampling step, so a long or large
  clip is the usual cause of an OOM render — and the only way to shorten one was to drag
  its edge on the track, with nothing anywhere saying what it currently was. Selecting a
  clip now gives **start**, **frames** and **size** as numbers, with the seconds and the
  model card's 2–15 s window shown beside them.

  `start` and `frames` edit the segment's own trim and length rather than shadowing them,
  so the track keeps showing exactly what will be sent. `size` is the short edge the clip
  is decoded at, per clip because one reference may be carrying a look worth the pixels
  while another is only carrying a camera move — and it is the biggest lever there is,
  since memory goes with its square. The default is unchanged, so nothing moves until you
  turn it down.

- **A trimmed reference video is no longer silently lengthened.** The loader floored every
  clip at 2 s, so trimming one shorter handed the VAE *more* than was asked for — while the
  preview warned that the clip was under the model card's minimum. It warns and honours the
  trim now, rather than warning and overriding it.

- **Removed the Image Anchor.** An LTX concept that survived the port without ever being
  connected to anything: `isAnchor` was written by the editor, round-tripped through the
  timeline JSON, and read nowhere in Python — H3 has no per-keyframe guide strength for it
  to drive. Its only observable effect was locking your prompt box and drawing an orange
  glyph, so it looked like a feature while doing nothing but taking a field away. Old
  timelines load unchanged; such a segment becomes an ordinary image with an empty prompt,
  which is exactly what it already compiled to, and the flag is dropped on load rather than
  riding along in the JSON forever.

- **A reference video the browser cannot decode now works anyway.** The editor built the
  clip from a local blob through a `<video>` element, so it only accepted what the browser
  accepts — and a browser accepts far less than the renderer does. HEVC, ProRes and 10-bit
  footage inside perfectly ordinary `.mp4` and `.mov` files are all refused by Chrome and
  all read fine by PyAV, which is what loads reference videos at generation time anyway.
  Picking one did nothing at all, with a single `Motion video load error` in the console
  and no message on screen.

  A `probe_video` endpoint now supplies the duration, size and a first frame when the
  browser gives up, so the clip lands on the track and renders normally. The editor accepts
  what the renderer accepts. If the server cannot read it either, that finally says so on
  screen instead of failing in silence.

- **The chain node and the Director now share one reference loader.** The chain had grown
  its own copy that ignored the `ref_images` socket entirely and never fitted a keyframe to
  the canvas, so a chained render silently dropped references the Director would have sent.

- **The live preview says when it cannot count.** Images arriving on the `ref_images`
  socket are an upstream batch that does not exist until the graph runs, so the preview
  could not number around them and silently showed `<Picture 2>` where the render would
  send `<Picture 5>`. It now warns instead of quietly disagreeing.

- Removed a note-pruning path that parsed `<Picture N>` back out of finished sentences to
  drop trimmed references. Declarations are now built after the caps have trimmed, so
  there is nothing to prune — and the per-type caps made that path unreachable anyway
  (`images + videos` is at most 12 on its own, so the audio bucket always absorbs the
  excess).

## 0.1.6

- **The compiled prompt can be written by hand.** `EDIT` on the prompt panel turns it into
  a textarea, prefilled with what the timeline just compiled; `REVERT` throws the edit away
  and compiles again. Only the text is replaced — which images, videos and audio clips get
  loaded still comes from the timeline, because the tokenizer emits `<Picture i>` in the
  order the plan decided and a rewritten sentence cannot renumber that. The edit is stored
  rather than merged: discarding it when a segment moves would lose work without asking,
  and keeping it silently would leave a prompt that no longer matches the screen
  ([#4](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/4)).
- **A timeline picture opens its shot rather than ending the video**
  ([#4](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/4)). On a hard
  cut the second image starts shot 2; 0.1.5 read the fl2va anchor roles and announced it as
  what the shot "ends on". `ends on` is now reserved for a segment explicitly flagged as an
  end frame, which is the only place that intention is stated rather than inferred from
  geometry. Also from #4: `Keep the identity, face and clothing of …` is now `appearance`,
  since a subject slot holds whatever was put in it and only some of those wear anything.
- **The preview's playback rate is a choice, not a decision made for you.** `true speed`
  (the default, unchanged) spreads the sampled frames across the shot's real duration, so
  the preview lasts as long as the finished clip — with `latent2rgb` that caps at
  `preview_fps / 3.35`, because there is one image per latent frame and H3 compresses time
  by that much. `source fps` plays them at the shot's own rate the way ComfyUI's preview
  does: motion reads normally, the clip ends early. Measured on a 124-frame shot: 4.65 fps
  against 24.0.
- **Subject slots are a number you choose**, 1 to 9, still 3 on a fresh node
  ([#8](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/8)). Three was
  hardcoded in four places and came from nowhere in particular; the model card caps
  reference images at nine and each slot holds two. `@char4` and beyond resolve now.
- **Images on the `ref_images` wire can be described.** One line of `ref_image_notes` per
  image, emitted in the guide's own shape (`<Picture 3> is a storyboard reference for …`).
  Blank lines are kept as placeholders so line 3 always belongs to the third image. Before
  this they were numbered and the prompt said nothing about what was in them
  ([#8](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/8)).
- **An audio reference can say whose voice it is**
  ([#10](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/10)). Pick a
  subject on the clip and the prompt uses the reference guide's own sentence, `<Audio 1> is
  the voice-timbre reference for <Subject 1>.` With more than one subject there was
  previously no way to say which voice belonged to whom. Unassigned clips keep the old
  wording. (The guide ends that line with a speaker ID, `(S1)`; this does not write one,
  since IDs are assigned in the order voices are heard and the subject may never speak.)
- **`unload_after` reaches llama.cpp**, not just Ollama
  ([#9](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/9)).
  llama-server in router mode has `POST /models/unload`; a plain one does not, and the log
  now names `--sleep-idle-seconds` instead of leaving a checkbox that quietly does nothing.
- **A canvas too small to encode is refused by name.** Under 32px per side the video latent
  loses an edge and ComfyUI dies six frames deep with a bare `float division by zero`.
  Reachable from the widgets: `custom_width=4` with `divisible_by=1` was enough. Not the
  cause of the crash reported in #4, which is still open.
- Fixed: adding a widget shifted every saved value after it, so `playback` first landed on
  `webp_quality` and blocked the node with *"The value 80 is not available"*. New widgets go
  last now, a combo whose saved value is not among its options falls back to the default
  with a warning instead of blocking, and both nodes grow to their minimum height on load so
  the panels below a new widget cannot end up hanging outside the node body.
- `CONTRIBUTING.md`, and `test_plan.py` is up to 123 offline checks.

## 0.1.5

- **Picture notes in `Refs ON` use the reference guide's own phrasing**
  ([#4](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/4)).
  `VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` gives it verbatim — "the shot begins from
  `<Picture 1>`", "the shot's keyframe corresponds to `<Picture 2>`", "the shot ends on
  `<Picture 3>`" — and asks for a standalone `<Picture N>` exactly when an image "serves
  as a shot's first frame, keyframe, last frame, edited keyframe, or composition anchor".
  So ref2va does carry frame anchors in its notation; what it does not carry is FL2VA's
  vocabulary. 0.1.4 dropped the anchors along with the wrong words, which threw away
  information the guide wants stated:

  ```
  0.1.3   <Picture 2> is the opening frame.                    FL2VA's words
  0.1.4   <Picture 2> is the timeline image at 0s (a.png).      no anchor at all
  0.1.5   [Shot 1] begins from <Picture 2>.                     the ref guide's words
  ```

  Middle images keep their timestamp: `The keyframe of [Shot 2] corresponds to
  <Picture 3>, at 6s.` Shots are numbered the way the body numbers them — counting only
  shots that carry text — and an image whose segment has no text gets shot-free phrasing
  rather than a number the reader cannot find. Filenames are gone from the notes; the
  guide has no such notion and the model gains nothing from `b.png`.
- The phrasing still does not flip on where a segment happens to end, which was the
  reported bug: an image flush with the window and the same image three frames shorter
  now differ only in the role the guide would give them anyway.
- **When a sound box wins over an `Audio:` / `Music:` line, the log says so.** That line
  may be work the Enhance node's vision model just did, and discarding it in silence was
  wrong even though the precedence is right.

## 0.1.4

- **`overall_soundscape` and `non_diegetic_music` have their own boxes** under the Global
  Prompt, which is what both prompting guides ask for
  ([#7](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/7)). They
  live in the timeline, so the COMPILED PROMPT panel and the node read one and the same
  value — node widgets would have meant a third copy to keep in step. Empty boxes emit no
  section at all. `Audio:` / `Music:` lines in the prompt text are still lifted into the
  same two sections, so older workflows and the Enhance node are unaffected; a filled box
  wins over a lifted line. The boxes do not switch with Retake Mode: re-rolling a range
  does not change what the room sounds like.
- **`Refs ON` no longer calls a timeline image an opening or closing frame**
  ([#4](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/4)). ref2va
  has no keyframe slot, so that wording promised an anchor the checkpoint cannot honour.
  Worse, it depended on where a segment happened to end: an image flush with the end of
  the window read as a closing frame, the same image three frames shorter read as a
  timeline image, and nudging the segment was the only way to get sane wording. Every
  timeline image is now described by the time it sits at. The role is still tracked
  internally, where it decides which frame of a *video* segment is used.
- **The alignment line's end mark is floored to the hundredth, not rounded**
  ([#6](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/6)). 124
  frames last 5.166667 s and were reported as `5.17`, a moment past the end of the clip
  being described. Ten of the twenty-four valid frame counts up to 16 s rounded that way.
  Prompts for those lengths change by one hundredth, so a fixed seed will not reproduce a
  0.1.3 render exactly.
- **A connected `duration` of 0 now fails with a message that names it**, instead of
  clamping to one timeline frame and rendering five in silence. That is what an upstream
  node hands over when its own value was never set, and 0.1.3's new `duration_seconds`
  output is meant to be wired exactly there. `end` before `start` and a negative `start`
  are refused the same way.
- The over-length warning no longer points at the Director Chain node, which was withdrawn
  in 0.1.2, and quotes the trained range as 4-15 s to match the model card.
- `test_plan.py` ships with the package: 86 offline checks over the planner, no server
  needed.

## 0.1.3

- **New node: MiniMax H3 Enhance Prompt.** A local vision model (Ollama / LM Studio / any
  OpenAI-compatible endpoint) turns up to nine reference images plus a one-line idea into
  prompt text for the Director's `global_prompt`, and passes the same images on to
  `ref_images` so it describes exactly what H3 will condition on. `duration_seconds` is an
  output too, so it is typed once
  ([#1](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/1)).
  Image sockets grow as you connect and close their gap again when you disconnect.
- The vision model is evicted from VRAM when the node finishes, including when the call
  failed part way — that is exactly when one would otherwise be left resident while H3
  starts sampling. Switchable off while iterating.
- Two prompt presets: `global` leaves the shots to your timeline, `storyboard` writes the
  whole shot sequence with timestamps.
- The model's output is filtered against what the Director owns: section labels,
  `<Picture N>` numbering and — in `global` mode — shot markers are removed, the first
  shot's timestamp is dropped in `storyboard` mode, and the length is trimmed to a
  sentence boundary. Small models do not follow those rules from instructions alone;
  measured examples are in the commit history.
- The `Audio:` / `Music:` lines are requested in a second short call when the first answer
  leaves them out. With `qwen3.5:9b` that moved them from 0 of 4 runs to 4 of 4, so the
  Director's `overall_soundscape` and `non_diegetic_music` actually get filled.
- An address without a scheme (`127.0.0.1:11434`) is accepted rather than rejected by the
  HTTP layer, in the node and in the gear menu's Analyze button alike. `on_error =
  passthrough` now catches everything, not just VLM errors — the guard that exists to keep
  a broken endpoint from killing a render was not catching the case that actually happened.

## 0.1.2

- **Reference images are numbered along the timeline.** `<Picture N>` now counts up with
  time — opening frame, whatever sits in between, closing frame. Previously the keyframes
  were assigned in a second pass, so an image dropped in the middle took `<Picture 1>` and
  pushed the opening frame to `<Picture 2>`
  ([#5](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/5)).
  Character slots keep their numbers ahead of the timeline, so a character never renumbers
  when you drop an image on a track.
- **`Refs OFF` prompts carry the image-alignment instruction** the base prompt guide
  requires as their first line, in the exact wording MiniMax documents for I2VA, FL2VA and
  L2VA. T2VA has none, and the reference guide does not ask for one, so `Refs ON` is
  unchanged ([#6](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/6)).
  The duration it names is the effective one, after snapping to the 17k+5 grid.
- **Director Chain is withdrawn.** Its sampling worked, but there was no usable way to
  give it a timeline: the editor attaches only to the Director, which has no
  `timeline_data` output to wire from. Shipping a feature nobody can operate is worse than
  shipping none ([#4](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/4)).
  The code and the full reasoning stay in `minimax_chain.py`.
- Retake Stitch passes the video through unchanged when there is no retake, instead of
  failing.
- Fixed: when the 12-file reference cap trimmed several images, only the first one's note
  was removed from the prompt.

## 0.1.1

- **Only the checkpoint the toolbar asks for is loaded.** Both model inputs are now lazy
  (`check_lazy_status`), so `Refs OFF` never reads `ref2va` and `Refs ON` never reads
  `fl2va`. Before this, ComfyUI resolved both inputs before the node ran and read ~42 GB
  of weights to use half of them — enough to push a 32 GB machine into a page-file crash
  while the text encoder was still loading ([#2](https://github.com/seesee75-commits/ComfyUI-MiniMaxH3-Director/issues/2)).
  Connecting only one model still works, with the same warning as before.

## 0.1.0 — first public release

The LTX Director timeline editor by WhatDreamsCost, ported to MiniMax H3.

**Director**
- Timeline compiles to a storyboard prompt instead of a cross-attention relay mask
  (H3's DiT hardcodes `mask=None` over one packed `[text | cond | audio | video]` sequence).
- Two prompt notations, switchable in the gear menu: **MiniMax** (the notation from
  MiniMax's own prompt-writing guide, default) and **ComfyUI** (`[0s-1.5s] …`).
- Two optional model inputs — `fl2va` and `ref2va` are separate trainings; the toolbar
  switch picks the matching one.
- First/last keyframes only, matching H3's `PackedLayout`. Images elsewhere become
  `<Picture i>` references in Refs ON mode and are reported in the warnings otherwise.
- Reference-video track (`<Video k>`) replaces the IC-LoRA track — no IC-LoRAs exist for H3.
- Native joint audio; imported audio becomes `<Audio j>` and/or is muxed via `combined_audio`.
- Model-card limits enforced: ≤ 9 images, ≤ 3 videos (2–15 s each, ≤ 15 s total),
  ≤ 3 audio clips, ≤ 12 files in total.
- Live **COMPILED PROMPT** panel, served by the same planner the node runs — it cannot
  drift from what is actually encoded. Collapsing it, or switching it off in the gear
  menu, shrinks the node by exactly that much and releases the canvas underneath.

**Preview Override**
- Renders the whole shot while it denoises, instead of core's single first latent frame.
- Unpacks H3's packed AV latent (`unpack_latents`) — the callback receives the flat pack,
  not the nested view.
- Playback rate derived from the *output* duration, so the preview lasts as long as the
  finished shot (H3 compresses time ~3.35×).
- `latent2rgb` or the real video VAE, with a render-time overhead budget.
- `preview_fps` is a FLOAT input, so the Director's `fps` output wires straight in.

**Retake Stitch**
- Regenerate a marked range anchored on the base video's own frames either side, then
  splice head + retake + tail back together, video and audio.

**Director Chain**
- Renders past H3's ~15 s training range by chaining in-range windows, each anchored on
  the previous window's final frame. Samples internally; outputs finished images + audio.

**Removed from the LTX original**
- IC-LoRA track, Prompt Relay, audio inpainting, Licon MSR / Ghost Mask reference modes —
  none of them have a MiniMax H3 equivalent.
