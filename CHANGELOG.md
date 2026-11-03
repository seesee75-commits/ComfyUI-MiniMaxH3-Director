# Changelog

## 1.0.1 (2026-11-03)

- **Example files are copied when you open an example, not on start** (#35). Opening an example workflow copies the
  `h3-example-*` files it uses into ComfyUI's input folder (a file already there is kept); nothing else lands there, and
  files you delete stay deleted until you open an example that needs them again. API users: `POST /ng/example_media`.
- **Nodes below a card no longer drift down** (#37). A card's height can differ by a few pixels between two measurements
  (browser zoom, display scaling); every upward step pushed the nodes below again. Only growth beyond the largest height
  so far moves them now.
- **Installs from the Manager without a GPU warning** (#36). The package no longer declares `GPU :: NVIDIA CUDA`:
  ComfyUI's install check compares that against "CUDA" or "CPU" and reported a conflict on every machine. The pack runs
  wherever ComfyUI runs MiniMax H3.

## 1.0.0 (2026-10-26)

The H3 Director for videos of any length, with nine example workflows, their input files and an illustrated guide.
Tested as 1.0.0-beta.1 (GitHub pre-release of 2026-10-26); 1.0.0 is the same code.

- **Nine example workflows** (Templates → "H3 Director"): text to video, characters and voice, music video, shots from
  pictures, pictures, storyboard, control video, inpaint, custom sampling; each with a thumbnail, its guide chapter and the
  example files, which are copied into ComfyUI's input folder on start (`h3-example-*`).
- **H3 Guide** node: the guide inside the graph, chapter by chapter, with pictures (also in `js/guide/en`).
- **Technical report** in `docs/paper`.
- **Models:** the Director lists every file it uses with its download (Settings → Models); the workflows carry download
  links for every model, the turbo LoRAs included; a turbo LoRA that is not installed keeps its name and says so.
- **Layout:** cards no longer draw ComfyUI's upload preview below themselves in Vue mode (it covered the node below); a
  node that grows by its content moves the nodes below it. The cards' "In the Studio" line is gone.
- **Tested through the interface:** every example was opened from Templates, set up as its guide chapter says and run;
  this found and fixed: a turbo LoRA chosen in Settings stayed under ComfyUI's *Missing Models*; workflows 7 and 8 ran
  5 s without control and warned on opening; a control clip to the project end warned about H3's last 0.1 s; warnings
  said "chunk 2" instead of "Render part 2"; four examples shared one workflow id and two saved under another's name;
  a voice sample's own words were spoken in parts where its figure had no line; workflow 4 cut its portrait pictures.
- **SKILL.md** for AI agents (install, models, examples, what goes wrong) and **GUIDE.md**, the guide in one file.
- The Legacy timeline Director stays, documented in `docs/legacy-director.md`.

The work that led here, newest first:


**Minute fixes and comparison findings** (2026-10-20): from a comparison with 19 other H3 projects and two one-minute test
videos. A shot change in a part's last two seconds moves the part edge (Ref2VA cut twice for one shot change). A part that
continues a shot opened on its own First frame picture gets that picture as a reference (FL2VA made a different dress after
a push-in). A shot's camera sentence goes to every part of the shot; a continued part without one holds a static shot. Two
independent character pictures described alike are flagged ("Same figure twice?", set *Belongs to*). References parts get a
summary sentence without the AI. NG Collect Video writes tagged BT.709 (colours were off in browsers). The footer shows the
turbo profile's steps; the gear warns of res_multistep + beta. **Effect** in the shot panel adds an official
`minimaxh3_*` effect embedding. The AI part writer gets rules for movement, camera moves at seams and skin words.
README: measured model, VAE and low-VRAM tips.

**Picture editor** (2026-10-20): the brush icon on an Image card opens a window with three tabs. *Mask*: brush, eraser, grow,
or SAM 3.1 finding what you name; saved as the card's edit mask for Pictures. *Structure*: a Pose, Canny or Depth picture of
the card, added as a new guide card with one click. *Character sheet*: H3 circles the figure once (REF2VA, ref2v turbo when
installed) and six views are put side by side - a sheet from one picture without Qwen. In Pictures a pose or layout card is a
guide that is not drawn. The Studio shows a picture project's parts as "Picture N" under their shots.

**Pictures** (2026-10-19): the Director's new **Output** switch (Studio, above the mode) makes one picture per shot instead of
a video. A shot with only text is text to image; cards on it are references (`<Picture N>`), so a character sheet, clothes, a
place and a pose drawing can be put together into one picture; a First frame picture on a shot is changed as the shot says and
otherwise kept; an edit mask on its card (`edit_mask`) samples only the masked area and puts the source's own pixels back
around it. Pictures are saved to `input/h3-director-stills` and appear in every Image card. Measured before building it: one
H3 latent frame decoded by ComfyUI's own VAE decode is clean (a 5-frame context gave stripes and a veil); H3's Fun ControlNet
does not steer a single frame, a control picture given as a reference does. Turbo LoRAs carry measured picture values
(Larry v4 turbo: 8 steps; official ref2v turbo: 6).

**Models menus** (2026-10-19): the extra models NG uses (SAM3, Qwen Image 2.1, background removal, pose, depth, Whisper) are
listed once in `js/ng/models.json`. A gear on the Video and Audio cards, in the Storyboard and in the Director's settings shows
what was found (*Automatic*: the official names), lets you pick a renamed or own file, and names a missing one with its folder
and download link. A missing model never stops a render: place pictures stay as rendered, the other tools say what is missing.
The README lists them all (Extra models).

**Node sizes** (2026-10-19): drag a node taller and its preview grows with it — the picture or video keeping its shape
(Image and Video cards), the waveform (Audio), the note (Text), the timeline's shot lane with more of each shot's text
(Director); the Storyboard puts sheet and panel above each other at full width. Dragged below its content it goes back to it;
the size is saved with the workflow. The AI Loader keeps a minimum width. Video card: a playhead over "Part of the file to use"
follows the preview, the video's own sound is drawn under it, playback stays in the chosen part; Audio card: a playhead you
can drag, a click on the waveform jumps there. Upload no longer runs into the Not analyzed badge.
**AI Loader** in the Context cards' look (boxes, captions, fields, buttons, blue choice), 660 wide like the cards, exactly as tall
as its panel (no inner scrollbar, no empty area under it; a taller drag goes back after the drag).

**Place like Shot N** (2026-10-18): a shot can take the place of an earlier shot (shot panel, *Place*). While rendering, the
Director saves a picture of that shot's render (1 s in) and gives it to the later shot as a Place card, so a room H3 invented
comes back the same after a cut; it shows as "Place of Shot N" under Made from. The later shot opens a render part of its own
for it, as a cut. Tested with tavern -> market square -> tavern: without it H3 drew another room, with it the same tavern.
*Picture*: **Without people** (default) takes the frame with the least person in it (SAM3) and lets Qwen Image 2.1 paint out
a person still there, so the figure does not appear twice; **As rendered** keeps the frame 1 s in; **From another view**
has Qwen paint the place from the camera you describe (the picture brings its camera along). Idea from ATAS (arXiv 2610.20571).

**Tidier node list** (2026-10-18): the 11 internal nodes (chunk conditioning, noise, sampling, resume, control chunk, project
chunks, turbo LoRA, AI request/result/media/encoder check) are no longer listed in ComfyUI (dev only; saved workflows and Render
Sequence still use them). The blocks of an own loop moved to **MiniMax H3/NG/Custom loop**, Enhance Prompt, Retake Stitch and Save
Last Frame to **MiniMax H3/Legacy** beside the Legacy Director. NG Collect no longer fails on an empty `resume_settings` field.

**A simpler Director** (2026-10-18, user: "it works, but it is hard to use"):

- **Settings behind a gear** (header and bottom bar): render part, size, fitting, reference size, seed, steps, sampler,
  scheduler, shift, turbo LoRA, resume, ControlNet strength, ambience, music, style, transitions and the manual prompt. The page
  keeps Prompt, Look, Content, Timeline, Mode, Turbo on/off, Duration and Resolution; explanations are small i tooltips.
- **One Prompt card**: the story, the Look and every AI button (Make H3 prompt with its options, AI: split into shots,
  Whole prompt = one shot) in one place.
- **Manual prompt warning**: while a manual prompt is set the page says so, with Clear and Edit (it had silently become "true").
  Turbo without a LoRA says so on the page with a button to Settings.
- **"Made from"** under each part in Prompts per render part: the shots, cards, Look, rules and settings its prompt comes from,
  hover shows the text, a shot chip selects the shot, a shot without text is flagged.
- **The AI gets everything**: Make H3 prompt now also sees the Text cards (style, rules, characters) and the Video cards; a
  control video's source is never described (also in AI: split into shots).
- **H3 Context Text (Style & Rules)**: the story belongs in the Director's Prompt; new Text cards no longer offer Scene, an
  existing Scene card keeps working and says so.
- AI fixes: the text "true" in Prompt override is repaired on load; writing AI tasks get at least 2048 tokens; time beats keep
  one camera sentence and drop copied beats.

**Video Context source-frame fidelity** (2026-10-15):

- Continue reads the final original frame before the selected source end, including 30/60-fps and variable-rate files.
  Resampling the tail to 24 fps could discard that frame.
- Video references and control sources use native float colour decoding and display rotation; conversion through 8-bit RGB
  changed the native conditioning. Timestamp offsets are normalized, and EOF padding holds the actual final decoded frame.
- Audio references retain the source sample rate and samples until the native H3 audio encoder; unnecessary intermediate
  resampling changed paired video/audio conditioning.
- Continue + Send along supplies the selected source as a paired video/audio reference in Auto and Ref2VA, alongside the
  exact continuation frame. Explicit FL2VA reports the soundtrack limitation. Studio keeps Continue cards active in FL2VA.
- Video-card Upload opens its own picker and saves through ComfyUI's native upload endpoint, including frontends whose
  generated upload widget has no button callback. Descriptions also reach the prompt for Motion, Continue and Control.
- Opening or closing the original-video comparison resizes the card's node to its actual content without repeated growth.

**Control video cards and Studio lane** (2026-10-14):

- Context Video: Canny/Pose/Depth control role, queued generation with installed native nodes, saved result and original
  preview; optional Depth Anything 3 when its package is loaded.
- Context Connector: optional raw/lazy `model_patch`. Studio: Control lane, clip move/trim/source offsets, strength and
  denoising range. Render Sequence applies native H3 ControlNet internally and skips parts without control clips.
- Partial coverage holds edge frames to the render-part edges and is reported in the Studio. Resume keys track control
  files, windows and settings. The standalone Control Video node moves to NG/Technical.
- **Inpaint cards:** keep the source video, generate a separate SAM3 mask by object description or load/upload a ready mask.
  The Control lane renders paired source/mask windows, with editable bounding-box/silhouette and grow (default box + 16 px).
  Resume tracks mask files and shape settings. Mask generation runs once; rendering reuses its saved result.
- Director restores named ControlNet settings without rotating them as positional legacy values on Save As/reload; the
  advanced denoising panel stays open while planning redraws it.

**Live preview in Render Sequence, one-sentence shots shared, README** (2026-10-14):

- **H3 Render Sequence shows the TAEHV live preview** of every part when the Context Connector has a `preview VAE` (taeh3): it
  inserts ComfyUI's preview wrapper (`NGH3Preview`) before each part's sampler, and the player appears on the Render Sequence
  node with the first frames. Without a preview VAE nothing changes. Preview Override (live) stays for your own sampler.
- **A shot written as one sentence is shared over its render parts**: inside a sentence the text is cut at words that say one
  step follows another (`…, then`, `and then`, `, before/until/ending/finally`, `and back toward`); a clause goes to a part only
  when a quarter of its time lies there. Real case: "…away from the camera and back toward it, ending in a close-up" went whole to
  both parts and Luna turned away again at 13 s; now part 1 walks away, part 2 comes back and ends in the close-up.
- Studio plan errors checked in the UI (duplicate card names): the timeline shows "The plan failed: …" and Generate is disabled;
  renaming the card plans again. The older note "stays on Planning …" no longer applies.
- README: the NG section describes the Storyboard, turbo profiles, resume, live preview and Control Video.

**Drag and drop pictures onto the cards** (2026-10-14):

- H3 Context Image, Video and Audio: a file dragged from a folder onto the card is uploaded by ComfyUI's own upload of that node and becomes the card's file. Before, the card covered the node and ComfyUI added a new Load Image node instead.
- H3 Storyboard: picture files dropped on a panel of the sheet or on the panel canvas land on that panel (on the canvas at the drop point); several files stand side by side; pictures dragged from ComfyUI (queue, the board's thumbnails) need no new upload. Shared helper `js/ng/ng_drop.js`.

**H3 Storyboard: figures from sheets, backgrounds, pictures for every panel** (2026-10-14):

- **+ Figure from a sheet**: Qwen Image 2.1 draws a character card's figure in the pose and camera angle the user writes, on a transparent background (the template's RGBA prompt; the PNG carries alpha). Real test: Luna kneeling with her weapon, Inferna in profile with crossed arms and wings, from their sheets, 33 s each.
- **+ Background**: an empty place in the panel format (16:9: 1376 x 768), opaque, about 20 s.
- The board keeps its own pictures (library); "+ Picture" offers them and every picture already on a panel under "From this storyboard". **Use on all panels** copies a layer onto every other panel.
- Redraw names its pictures `<image1>`, `<image2>` ... as Qwen Image 2.1 expects, and drops the alpha channel the VAE decodes. The Qwen and queue helpers moved to `js/ng/h3b_queue.js`.

- H3 Storyboard: the **AI provider** input is gone; the Storyboard uses the AI provider of the Context Connector on its **H3 context** input, as the Director does. One cable is all it needs (user feedback 2026-10-14: two ports for the same thing were confusing).

**Turbo profiles measured** (2026-10-14, real renders on the same scenes and seeds):

- Official Ref2VA v0.1: 4 steps stays (6 and 8 look the same at 1.7x / 2.1x the time). ckpt500: 8 steps Euler + Beta stays; 4 steps give green, oversaturated faces.
- Official FL2VA v1.0 "8step": now **4 steps** (4, 6 and 8 look the same; 4 takes about half the time of 8). FL2VA v1.2: 4 stays (6 the same at 1.4x).
- Taomate: now **3 steps** (3 and 4 look the same in FL2VA and Ref2VA). On the official Ref2VA model with a storyboard card, Taomate showed the sheet itself in the first frames; the official LoRA did not.

**H3 Storyboard, stages 3 and 4** (2026-10-14):

- **Redraw with Qwen Image 2.1**: a panel's collage becomes one finished picture in the style of the character cards it names (ComfyUI's Qwen Image 2.1 nodes as a queued job, 25 steps). Real test: two cut-out portraits on a colour became Luna and Inferna facing each other in a gothic hall, with halo, horns, wings and tail from their sheets, in 49 s. The result is a new layer over the collage; each redraw takes a new seed. **Redraw all panels** does every panel and names the ones it skipped.
- **Send to Director**: the panels become the Director's shots (times, shot texts) with the storyboard card on every shot and marked panels as first frames of their shots; the Director's sound lanes, Look and Prompt stay. Real test: the Director planned the 4 panels at once (17.5 s, two render parts).
- The jobs moved to `js/ng/h3b_jobs.js` (the editor stays under the module size limit).
- Director: a workflow saved in the few hours when "resume" was a required input loaded Prompt override and Resume swapped ("director.prompt_override: expected text, got bool"); the Studio puts them right on load.

**H3 Storyboard, stages 1 and 2** (2026-10-13):

- New node **H3 Storyboard**: a storyboard sheet laid out in the node, in the look of the user's ChatGPT boards (title line, numbered panels with time and title on the picture, caption below). 1 to 9 panels, six panel formats, panel seconds end to end.
- Each panel is a stack of layers: pictures from the Context cards, the input folder or an upload; texts; a colour. Drag to move, wheel to size, Shift + wheel to turn, mirror, opacity, order, hide; undo and redo.
- **Cut out** runs ComfyUI's Remove Background (BiRefNet) as a small queued job and puts a transparent PNG in place of the picture (real test: about 3 s).
- **AI: write panel texts** writes the sheet's title line and every panel's title, caption and H3 shot text from "What should happen", with the Studio's shot rules; a panel longer than 5 s gets its time beats in the answer's example. Real test with qwen3.5:9b: 4 panels in 10 s; 5 of 5 answers valid, the 10 s panel in beats in 4 of 5.
- Outputs the sheet, the panels' pictures and the panels as the Director's shot document; the browser draws and uploads them when the workflow is queued. **Use in Director** adds a Context card with the sheet (usage Storyboard), connected to the Context Connector, with the file list's own spelling of the path (Windows uses "\\").
- The editor tells ComfyUI's change tracker about every edit, as the Studio does, so the browser's restore after a reload keeps them (found in the UI test: the last edits were lost).

**The AI writes complete H3 shots: framing, camera, time beats** (2026-10-13):

- Every shot the AI writes (AI: split into shots, Make H3 prompt, AI: improve text) begins with its framing and says how the camera moves, with amplitude and speed, or that it "holds a static shot" (MiniMax's H3 guide). Nothing is appended automatically; said by the AI, a still camera also keeps 4-step turbo from drifting into a close-up.
- A shot longer than 5 s is written in time beats in seconds from the shot's own start ("0–5s: ... 5–10s: ..."), as many as its length needs. The shot times are never changed: a split's beats are fitted to the shot's real length; when the AI improves existing shots the beats come from each shot's own length (5 s, 10 s, 2.5 s ...), and a proposed timing is dropped ("shot times stay as set"). The render parts give each part its own beats (shot_share), and the part writer keeps them.
- Real test with qwen3.5:9b: split into shots 6 of 6 valid, every 10 s shot in beats; improve text 6 of 6 accepted, the 10 s shot in beats each time. Two parser fixes from it: a copied example line without words ("text":[] or "[]") is no spoken line, and two patches for different fields of one shot are merged instead of refusing the draft.

**Turbo LoRA profiles, no preselected LoRA** (2026-10-13):

- The user chooses the turbo LoRA; the Director no longer preselects one. A known LoRA brings its measured steps, sampler and scheduler (`js/ng/turbo_profiles.json`, read by Python and the Studio): official Ref2VA v0.1 and FL2VA v1.2 4 steps, FL2VA v1.0 8 steps (res_multistep, simple; ComfyUI's templates), Taomate 4 steps, the ckpt500 turbo 8 steps Euler + Beta (its Civitai page).
- Each render part samples with the profile of its own model's LoRA (new NG Chunk Sampling in the loop; Director Output hands it to external samplers too), so a video mixing FL2VA and Ref2VA parts renders each with the right values. An unknown LoRA keeps the Director's settings. Selecting a known LoRA in the Studio sets Steps, Sampler and Scheduler to its profile; Turbo off brings back the settings from before.

**Resume parts are deleted when the video is done** (2026-10-13):

- New box under Resume, on by default: once Collect has put the video together, its kept parts are deleted, so they do not fill the disk unseen. Off: they stay 14 days. Real test: a two-part render left none of its parts in the folder; other projects' parts stayed.
- Workflows saved before it keep their values: the Studio fills in every missing new widget (`repairInsertedWidgets`).

**Resume after a crash** (2026-10-13):

- A **Resume** switch on the H3 Director (Studio, under Turbo; on by default) turns it off: then nothing is kept.
- H3 Render Sequence keeps every finished render part's raw latent in `output/h3-director-resume` and reuses it when the same plan is queued again: a run that died after hours only samples the parts it had not finished (its sampler is not run for a kept part). A part's key covers its plan, prompt, references and their files, the render settings and every part before it, so changing part 5 renders part 5 and everything after it again. Kept parts are removed after 14 days. The models are not part of the key: after swapping a checkpoint, empty the folder.

**H3 Control Video (experimental)** (2026-10-13):

- **mask_shape** (box / outline, default box) and **mask_grow** (default 16 px): a mask can be regenerated as its bounding box per frame. With a figure's own outline the region outside a new, differently shaped figure stayed grey, in ComfyUI's own workflow as well; with the box the rim was gone (real test, ControlNet-Union 2.0).
- Between H3 Director Output and the sampler: steers each render part with a pose, depth or edge video (MiniMax H3 Fun ControlNet-Union, ComfyUI's own apply node), or regenerates masked regions of a source video. Each part gets its own window of the videos, its pinned head included.

**A shot over several render parts is no longer played again in each part** (2026-10-13):

- Each part gets the action of its own share of the shot's time. Time beats in the shot text ("2.5–5s: ...", seconds from the shot's start) go to the parts they fall in, re-timed to the part; other text is cut into sentences and "..., then ..." clauses and laid over the shot's time by length. A shot whose remaining frames lie only in the pinned head gets no action ("The shot from the preceding video ends here, without new action.").
- Real runs before the fix: Aurelia walked away and back twice in a 20 s shot over two parts; in the user's 30 s storyboard each part replayed the shots its pinned head only finished.

**First / last frame mode uses Reference pictures** (2026-10-12):

- A Reference picture reaches H3 next to the first and last frame: "The appearance of Aurelia (face, hair, outfit and props) comes from <Picture 3>, a reference picture that is not a frame of the video." The frames keep <Picture 1> / <Picture 2>. ComfyUI's fl2va node has no reference input, so the Director builds this conditioning itself (no ComfyUI change). Real tests, same seed with and without: an elf portrait kept her face and staff up to a close-up; Aurelia's character sheet brought the gear emblem on her back and her leg armour, neither visible in the first frame, and nothing of the sheet's layout reached the video.
- A Reference picture no longer becomes the First frame of its shot or of the video (it did from 2026-10-11). For a start picture choose First frame. Video and sound references stay unused in this mode (`reference_disabled`).

**A render part tells H3 which storyboard panels are its shots** (2026-10-12):

- A storyboard over more shots than one render part holds now says which of its panels the part's shots are: "<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order. [Shot 1] is its panel 3 and [Shot 2] is its panel 4." Each part numbers its shots from [Shot 1], so every part of a 30 s storyboard pointed at panels 1 and 2. Panels count the shots the storyboard is on, in story order.
- Three or more shots are listed as "[Shot 1], [Shot 2] and [Shot 3]" (was "[Shot 1] and [Shot 2] and [Shot 3]").

**References mode names First and Last frame pictures as MiniMax's guide does** (2026-10-12):

- A First frame picture is "<Picture 2> is the first frame of [Shot 1]" and a Last frame picture "... the last frame of [Shot N]" (ref-en 2.2). They were "a composition anchor at 0s" and "the last frame of the target video", because the picture reached the prompt compiler as a segment without text and so without a shot. In a real test, Ref2VA with the start picture as First frame and a portrait as reference kept the face, staff and jewellery up to the close-up, where First / last frame mode with the start picture alone changed the face and started the walk a second time.

**References reach H3 as its released pipeline sees them, on a stock ComfyUI** (2026-10-12):

- Pictures and reference videos are brought to the Qwen size of H3's released processor before the stock H3 nodes get them. The stock encoder uses the shared Qwen limits: a picture under 256x256 got fewer vision tokens than H3's minimum of 64 (a 64x64 one got 4), and a long reference video got more than H3 was trained with. Same tokens as H3's processor now (tested pixel for pixel).
- A reference video's soundtrack is cut with the video. The stock node shortens the video to the 17k+5 grid (72 selected frames keep 56) but kept the whole sound, so it ran past its picture.
- Both happen in the Director (`minimax_refprep.py`), not in ComfyUI: the pack never patches ComfyUI, and gives the same result on a patched and an unpatched install.

**Storyboard as MiniMax's guide describes it** (2026-10-12):

- A Storyboard picture on shots is, in References mode, one reference picture that plans them: "<Picture N> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order." It was a keyframe guide at each shot's start, which pushed the sketch itself into the video. A storyboard card on no shot plans the whole video. It needs no scene time; First / last frame mode does not use it and says so (`storyboard_unused`).

**AI prompts name the end pose in First / last frame mode** (2026-10-12):

- Make H3 prompt and the part writer ask the AI to name the final pose, framing and light of a last frame or keyframe picture, as MiniMax's guide asks (describe the path between the frames). With 4 steps, H3 otherwise pulled the last frames onto the picture; with the end pose in the text the approach was even (measured).

**Less memory when the video is put together** (2026-10-12):

- NG Collect and NG Collect Video no longer copy the last part's picture after decoding. The copy only guards decoders that reuse their buffer on a later call; after the last part there is none, and a single 12 s part ran out of memory on the 3.1 GB copy.

**FL2VA: a loose Reference card no longer replaces shot 1's picture** (2026-10-11):

- In First / last frame mode a Reference picture on no shot opens the video as First frame only when the first shot has no picture of its own. A real test opened on the loose card's picture instead of shot 1's.

**One part for a section just over the part length** (2026-10-11):

- A section up to one H3 grid step (17 frames) longer than the part length stays one render part. A keyframe at 10 s with 10 s parts ended its part at 10.08 s on the grid, and the 243 frames were split into two parts of 5 s.

**Studio fixes from the open JS bugs** (2026-10-11):

- Removing an audio lane takes its clips with it, so the lane does not come back on load (BUG-023).
- A card that is both on a shot and on an audio lane is named in the clip panel: both play (BUG-004).
- The rename logic of the Director is one model function (renamedDirector) that the tests now check directly (BUG-079); text cards remember names on load and rename both kept versions (BUG-031).

**Dialogue, songs, drafts and the rest of the audit bugs** (2026-10-11):

- A written spoken line ("@Alice [English] says: ...") of a First / last frame figure becomes a proper dialogue line in First / last frame mode, also after prose on the same line (BUG-090); in References mode a shot-bound First / Last frame is that slot with its anchor text, as a global card is (BUG-091).
- AI split keeps the user's own lines with any delivery and a language tag (BUG-084), binds a speaker only to a figure picture (BUG-087/088, keeping the name as written) and no longer mixes figures without a card with the narrator (BUG-089). A shot draft line bound to an audio, text or video card is spoken by a voice of that name instead of failing the draft; locked fields are left as they are (BUG-086); a binding to a disconnected card is refused (BUG-058).
- Song lines are only sung where the song plays: up to the card's End and the file's end (BUG-085).
- A Continue video no longer reports "reference disabled" in FL2VA (BUG-093); unwired optional prompt inputs and Studio contexts are treated as empty (BUG-062/063); LM Studio and llama.cpp store their base with /v1 like the other providers (BUG-042, same URLs).

**Layout, turbo LoRA and open audit bugs** (2026-10-11):

- The Studio and the Context cards no longer collapse to one narrow, very tall column. Showing a node in ComfyUI's right panel (Parameters) wrote the panel's width (about 100 px) into the widget, and the node then laid out 80 px wide; our widgets now always take the node's width.
- The Director's turbo LoRA leaves out pieces that do not fit the model, with one note in the log. The full-model turbo LoRA (`minimax_h3_turbo_4step_ckpt500`) on a pruned H3 model logged "ERROR lora ...adaln_proj..." 51 times per step.
- A card with an empty Context ID keeps its bindings, speakers and descriptions in Make H3 prompt, the part writer, AI split and shot drafts, and is offered in "Belongs to" and "Whose voice" (BUG-047/049/050/051/052/053/054/056).
- Two cards whose names come only from their file (e.g. `scene1.png` and `scene1.wav`, or one picture twice) get a free name ("scene1 2") instead of stopping the plan (BUG-067); a failed plan shows in warning colour in the Studio.
- A video reference without a card no longer crashes the labels (BUG-032); a preset no longer writes a derived ID into the card (BUG-018); a voice card without "Whose voice" that a shot gives a line speaks for the one figure that shot shows, with a note (BUG-019).

**Keyframes at their own time inside a shot** (2026-10-11):

- In the Studio a picture in a shot can take its own role there (Reference, First frame, Last frame, Keyframe) instead of its card's. A Keyframe gets **Seconds after shot start** (new ones start in the middle); the panel shows the video time and where the plan put it, and a diamond marks it on the shot. Moving the shot takes it along.
- In First / last frame mode with continuity a render part ends on the keyframe as its last frame and the next part keeps its pin, so the shot runs on through the picture. Real 20 s test (First frame → keyframe at 10 s → Last frame): all three pictures hit (RMSE 0.044 / 0.049 / 0.046), no jump at the join, no cut. Parts end on H3's grid, so the keyframe moves up to a third of a second (`keyframe_moved`); one too close to the shot's start, end or another picture stays inside the part with a warning (`keyframe_too_close`).
- A Keyframe placed on a shot no longer warns "Set a scene time". The card hint for a Reference picture in First / last frame mode now says it opens its shot as First frame; the fallback note lists only pictures without a role of their own in their shots.

**A copied card gets its own ID and name** (2026-10-11):

- A pasted or duplicated Context card, or a preset loaded onto a second card, kept the first card's ID and name, and the Context Connector stopped the run: `id used twice (Mage and Mage)`. The later card now gets a new ID and a free name ("Mage 2") with a note on the card; a saved workflow that already has such a pair is repaired when it is opened. The Connector's message says what happened and how to fix it.

**Camera moves are not repeated in later parts of a shot** (2026-10-11):

- A written shot that continues into a later render part gets the continuation sentence there and loses its camera-move sentences; spoken lines were already dropped. Each part had taken "the camera pushes in" as a new push: a 20 s shot over three parts zoomed in until H3 cut to a glossy 3D-looking close-up (real FL2VA minute, cut at 33.4 s). With the same seed the cut and the look change are gone.

**FL2VA shots open on their First frame** (2026-10-11):

- With the mode set to FL2VA, a Reference picture is used as First frame (FL2VA has no reference pictures; they were dropped before). It stays the figure its text names.
- A Last frame bound to the last shot lands on the video's last frame, also when the video ends a few grid frames before or after the project length.
- In FL2VA with continuity, a shot bound to its own First frame picture starts a render part without a pin and gets the picture as the native first frame. Inside a pinned part H3 reached such a picture and cut one frame later, so the shot did not open on it. The shot start snaps to the nearest grid frame (`opening_moved` note); Ref2VA is unchanged.

**Seamless picture at render-part joins** (2026-10-11):

- NG Collect and NG Collect Video decode the picture of pinned parts as one continuous latent (regenerated heads dropped), window by window. Decoding each part alone ended it on the VAE's unblended lookahead clip and restarted the decoder at the next part: a one-frame brightness/contrast jump at every join (real minute: up to +0.013 luma). Sound handling is unchanged.

**H3 latent audit fixes** (2026-10-11):

- Global First/Last Frame cards now supply timed native guides in Ref2VA; FL2VA anchors are not duplicated.
- Explicit continuous-camera instructions prevent an automatically inserted cut; explicit transitions remain unchanged.
- NG Collect and NG Collect Video restore source waveform samples inside Lock spans, preserving offsets and mixed overlapping tracks without the short native-grid silence gaps.
- The accompanying local ComfyUI reference-node fix preserves all selected video frames and limits paired audio to the same reference window.
- The accompanying H3 encoder fix uses the released processor's image/video pixel bounds, including the minimum size for small references.

**Explicit preview VAE and external player** (2026-10-10):

- Context Connector accepts an optional `preview VAE`; Director Output exposes it as an appended VAE output without moving existing output slots.
- Live playback exists only on a connected Preview Override node. The Director/player and automatically inserted sequence previews are removed; `enabled` is removed.
- Preview decoding uses the VAE connected from a normal Load VAE node, with native device/dtype/offloading. The normal video/audio VAEs remain separate.

**TAEHV workflow loading fix** (2026-10-10):

- Loading an older preview node now creates plain input descriptors for added ports. Native slots and widgets contain node references and must not enter serialized workflow data.
- Regression tests cover native JSON cloning, connected MODEL/FPS inputs and saving/reloading migrated settings.

**TAEHV live preview** (2026-10-09):

- NG sequence rendering now attaches the H3 preview inside its native sampler loop. The Legacy Preview ID remains loadable.
- TAEHV is the only preview decoder; the RGB projection, full-VAE option and animated WebP/VHS paths are removed.
- Complete temporal decoding supports all 24 output frames per second with the original clip duration; spatial limits apply before decode.
- Studio and preview nodes share buffered playback with pause, scrubbing and separate update/cadence status. Step updates preserve playback phase.
- Saved widget layouts and link slots migrate on load, including the Director's connected FLOAT fps output.
- One CPU worker and one pending snapshot per sample avoid a growing preview backlog and GPU decoder offload during H3 sampling.

**Verified bug fixes** (2026-10-09):

- Every HTTP AI action uses the requesting user's saved API key. Google AI Studio uses its documented compatibility endpoints.
- Make H3 prompt retains Undo after Cancel or a part failure; late cancelled answers cannot change picture descriptions.
- Typing the first spoken line immediately reveals its add/remove controls without replacing the input.
- Analyze accepts an offered role returned as a role/meaning pair. FL2VA writer rules and checks agree on paired picture labels.
- Timed lyrics start at the selected clip's beginning, and a figure named Narrator remains separate from the anonymous narrator.
- Video analysis uses container duration when stream timing is missing. Split and Build accept complete JSON with surrounding prose while still rejecting ambiguous answers.
- Optional Director prompt inputs treat a connected `None` value as empty text before planning.

**Make H3 prompt** (2026-10-06): one button in the Studio for a finished H3 prompt from a direction and the pictures.

- Choose a direction (music video, song, story, action, calm, dance, horror, comedy, romance, Spicy 18+ for adults only) and
  whether anyone speaks; the AI sees the pictures, plans the shots and writes every render part out. The Prompt is optional.
- Empty picture descriptions are filled from the same answer; views and places are bound to the shots that show them.
- The part writer gets the direction and the part's pictures, writes the Ref2VA summary, and its slips are repaired: an extra
  shot marker, an invented line in a silent part, a dropped `[English]`, missing keyframe anchors (FL2VA/I2VA).
- A figure that speaks in one shot keeps its reference picture in every render part (it was dropped from the others).
- Later shots open with the guide's cut words ("At 00:04.000, the camera cuts to a close-up of ..."); a narrator line starts
  with a capital letter.

**One story, timed lyrics, a final prompt per render part** (2026-10-05):

- The Prompt (or a Text card used as Scene / story) is the story. With shots, H3 gets the shots plus a new **Look** that every part shares; the Prompt is no longer pasted whole into every part.
- **AI: split into shots** answers with real spoken lines (speaker, language, delivery, exact words), the camera as a sentence and a Look; it starts a new shot only when the view changes.
- **Lyrics** on the Audio card (LRC), timed with a local **Whisper** model or by ear; each render part sings only its own lines.
- **Prompts per render part**: Write with AI / Edit / Reset. The AI writes only the prose; the plan's structure is checked, small slips are repaired, an outdated own prompt is not used.
- First / last frame mode with only reference pictures now says so in the Studio's mode panel (it renders from text alone).
- Removed: **Build H3 prompt** on the Text card (its block nested inside the Director's own prompt).
- **NG Collect Video** writes a long project (a whole song) part by part into a video file; NG Collect would hold every frame in memory (177 s at 768x1152: 45 GB).
- Whisper timing of a whole song: lines after the last heard word are spread over the rest of the file instead of collapsing onto one instant; no audio-dulling warning when a lock covers the whole video; the Studio says when the prompt writer kept a part unchanged.

**A music video end to end** (2026-10-05): the user's 27 s elf song (picture, MP3, prompt with lyrics) rendered in both modes.

- Duration is any value on the 0.1 s grid with "= <audio card>" for the song's length (the list had no 27 s); a longer duration lets the last shot run on, so the added render parts keep their text.
- Spoken lines can be sung (says / sings / whispers / shouts / murmurs).
- Build H3 prompt keeps sung or spoken words verbatim and has room for a full storyboard (at least 1536 tokens).
- An image analysis names what keeps a figure recognizable (clothing, accessories), and the Subject sentence reads "<Subject 1> is an elfin woman", not "is An".
- A locked song stays exact in render parts whose length is not a whole number of audio latent steps (209 frames came back garbled).
- NG Collect has an **fps** output for CreateVideo: Director Output's fps sits inside the loop, and wiring it past End Loop made ComfyUI refuse the run ("loop boundary").

**Every AI function checked with real models** (2026-10-05): Context cards, Text card, Studio and the Legacy Enhance node, with Qwen3-VL 4B (Load CLIP and installed encoder) and Ollama.

- The Text card has ✦ Analyze ("Use as" from the note); Build H3 prompt over CLIP reaches the card; a Text card's native analysis gets its own role prompt.
- Analyze asks for "Use as" from the roles the card shows, each with its meaning, instead of free prose that no card could hold.
- Small-model answers are repaired instead of refused where possible (per-still video answer, role as key, unfitting content role, bad extra draft field), and each repair is named.
- Your own dialogue wins in a shot split; a built prompt with no description is refused; an echoed request, a missing key, Vision/Audio off and the H3 encoder are named plainly.
- Measured: `gemma-4-abliterated:e4b` cannot see pictures in Ollama here (it invents them); `qwen3.5:9b` can.

**Director sampling settings at the Output** (2026-10-05): H3 Director Output gains steps, cfg, sampler_name, scheduler, sampler and sigmas (appended, older links keep their slots), so an external KSampler or SamplerCustomAdvanced runs with the Studio's settings. sampler_name and scheduler connect to the classic KSampler as well as to KSamplerSelect/BasicScheduler.

**The Studio is the Director node** (2026-10-05): the compact Director with **Open Studio** is gone.

- The whole Studio is the node's face in the graph and the node is as tall as its content; **Full screen** lifts the same Studio over the window and Esc puts it back.
- Directors saved by the compact node, and Context nodes saved before the full cards, grow once on load; the nodes right of and below them move along so nothing overlaps.
- Keys pressed inside the Studio or a Context card stay there: with the node selected, Delete or Backspace on one of its buttons removed the whole node. Ctrl/Cmd shortcuts still work.

**Context cards** (2026-10-04): the four Context nodes are rebuilt as full cards in the graph after the accepted design v1.

- Each card shows name, file with Upload, what is in it (with Analyze → Accept/Discard), the default role with a hint that knows the Director's mode, what to keep, which figure it belongs to, preset and colour, and where the Studio uses it.
- Video: part of the file chosen by dragging across a strip; Audio: selection by dragging in the waveform, listening controls for playback only; Text: My note / AI prompt, Build H3 prompt, quick insert, templates.
- The node grows with its card, so cards no longer spill over their neighbours; example workflows are spaced for full cards.
- A keyframe or storyboard picture dropped on a shot in the Studio now guides that shot's start; before, it needed a time typed on the card.

**Studio fixes after first use** (2026-10-04):

- The Studio is in English.
- AI progress and failures were shown at the top of the page and scrolled out of sight, so a slow model or its timeout looked like nothing happened. They now float at the bottom of the window with the elapsed time, Cancel and a persistent error.
- **+ Shot** refused to add a shot once the last shot reached the project end (always after Whole prompt = one shot); it now uses any free room or halves the selected shot.
- Every spoken line of a shot is editable, with + Spoken line and remove; before, only the first was.
- A lost pointer capture ends a drag like a release.

**Studio** (2026-10-04): the Director's in-node editor is replaced by a full-screen Studio, built from the accepted clickable prototype.

- The Director node is small: prompt, duration, render-part length, resolution, a mini timeline, a summary and **Open Studio**. The Studio holds prompt, Content cards, timeline, mode, shot/clip panel, settings bar and a per-part prompt drawer on one page without inner scrolling; Esc returns to the graph.
- Shots move and resize on a 0.1 s grid and are reordered by dragging one over another. Content is dragged onto the timeline (new shot), onto a shot (assign) or onto an audio lane.
- **Audio lane clips**: free lanes added with +, clips with their own story range, an offset into the file and lock/copy/reference use. A lane clip continues across shots and render parts instead of restarting per shot; stored in the shot document's new `audio` list, older documents unchanged.
- **Mode** FL2VA or Ref2VA for the whole project, and **Turbo**: `LoraLoaderModelOnly` with the H3 turbo LoRA of the chosen mode and 4 steps; off is 20 steps. CFG stays 1 (BasicGuider, as in every official H3 template). LoRA preselection only accepts H3/MiniMax turbo files.
- Resolution as in the Legacy Director: Native/Fast/1920×1088 presets, aspect ratio and megapixels, width/height 0 = from the first picture by H3's own canvas rule, **Fit pictures** (crop, stretch, pad, pad green) and reference image size, passed through to chunk conditioning.
- AI in the Studio: **AI: split into shots** shows dashed proposals with Accept/Discard; **AI: suggest/improve text** per shot. Nothing changes without accepting; disabled with a reason when no AI Loader is connected.
- Fixed: First / last frame prompts contained `@refN` tags without any references (now plain names and `@voice(Name) says:`); older NG workflows shifted an empty trailing value into the new Turbo widget (repaired on load, examples updated); Studio edits were not marked as unsaved changes in ComfyUI.
- Removed: the old shot cards, story/generation tracks, inspector and direction review modules. Not carried over: **Analyze all contexts** and the raw Director-Context JSON view.
- 559 NG tests (one Windows skip), Legacy 374/374 + 74/74, all frontend suites. Browser run in a separate ComfyUI instance with real mouse input, Save/Reload and AI over a mock provider. GPU: FL2VA Turbo with a locked song clip over two parts (envelope correlation 0.97 at the intended place, lag 1.00 s, 0.97 on both sides of the seam) and Ref2VA Turbo with a consistent figure across both parts. No listening or quality assessment.

Earlier 1.0.0 work, in order of development:


- E42: one Director interface with directly editable duration, chunk target, resolution and sampling controls. Obsolete view properties are discarded on load; node sizes and render inputs are preserved. Technical nodes retain their IDs under NG/Technical. Fixed saved AI action choices showing the state from node creation instead.

- Native CLIP/Disk assistant jobs reuse ComfyUI Generate Text, model management and targeted queue cancellation. Four source cards have real execution paths; no AI request during connection/load/render.
- Separate Audio/Text layouts, real @Context editor highlighting, stable persisted context colors and compiler Output Inspector with Raw Context, budget, views and Override/Rebuild.
- Real installed Qwen3VL 4B: connected CLIP text/image analysis, disk text analysis and a complete 8-s Auto Direct proposal; browser Apply, stale-response protection, cancellation and tested-source status.
- E18: 194 NG tests (193 pass/one Windows skip), core line trace 98.03%, existing Legacy 371/371 + 74/74; limits and old tests preserved.
- Controllable AI flow: Manual/Assist/Auto modes, a checkbox per suggested field so Apply writes only what you tick, an optional reason for each suggestion, Analyze all contexts with per-card results and skip reasons, and scene proposals that keep dialogue you typed.
- E19: 216 NG tests (215 pass/one Windows skip), core line trace 98.23%, Legacy 371/371 + 74/74. The new AI controls have no browser run and no real-model answer on the batch endpoint yet, so they are not a product acceptance.
- One figure can own several voice cards: the first fills the subject's voice slot, every further take is still sent and named as a warning on each chunk. The Speaker menu offers only figures, stores context IDs and keeps an unconnected speaker visible.
- E20: 221 NG tests (220 pass/one Windows skip), core line trace 98.25%, Legacy 371/371 + 74/74. First run-time check against a live ComfyUI: 27 NG nodes registered and the `/ng/analyze_all` route answering for real. The panels themselves are still unseen and no render run was done, so R4 is not accepted.
- One First Frame and one Last Frame per chunk. Two Last Frames used to send two images to the model's single slot; now only the first is sent and the warning names the ignored ones. Frame guides are matched by role, so two cards on the same picture no longer swap each other's role.
- E21: 231 NG tests (230 pass/one Windows skip), core line trace 98.48%, Legacy 371/371 + 74/74, verified against a live ComfyUI in seven cases. No render run was done, so R6 is implemented but not accepted.
- One media file may be used by several context cards. Each card keeps its own identity, source window and role instead of
  adopting the first card that used the file. Prompt labels follow the order the media reach the model, and a video with a
  soundtrack is declared as `<Audio N> is the soundtrack of <Video N>` before a subject's own voice. `@Name` resolves to the
  label of that specific card.
- E29: 253 NG tests (252 pass/one Windows skip), core line trace 98.66%, Legacy 371/371 + 74/74. Four actual H3 GPU runs with
  file-loaded contexts: mixed, two sampler stages, duplicate files on several cards and Render Sequence, 97-154 s, each 294 frames
  and 392000 audio samples at 32 kHz with exact video/audio pins. Three failures were reproduced before the fix. Functional and
  mapping evidence only; listening, seam quality and long-chain identity are not measured.
- The H3 AI Loader panel now follows the reference look: a logo tile, a two-tone title with a subtitle, a tone-coloured status badge and an overflow button that collapses the source hints. Sections carry an icon, a caption and a `?` marker whose tooltip holds the explanation, and every field sits in a framed tile with its own icon. Icons are inline SVG in one module, so they follow the panel's colour. Verified in a real browser against the running ComfyUI; appearance only, no behavior change.
- The Text card is one plain note again: a tiled `T`, the name under the title, the note and its prompt side by side, and Preset, Build H3 Prompt and Quick Insert down the right column. Manual mode and the compact form are gone, so the card cannot collapse with no way back. Description, Context ID and Detected Content are no longer shown - the preset is stored whole and the note is the prompt - while Context Color and the Subject assignment stay, because `_scope_text` still scopes a note to its Subject. The card's own AI result now appears in the preview window: Analyze passed a host that `attachAnalysis` ignored, so the answer, the reason and Apply were written into a panel that was never mounted.
- "Use this prompt" and "Restore my text" are replaced by one switch between `My note` and `AI prompt`. Both versions are kept (`ng_text_note` and `ng_text_ai`) and the switch only decides what the editor shows and the Director reads, so a rewrite can no longer destroy the note it replaced. The AI version is read-only, and a second build can no longer overwrite the stored note.
- One system prompt per node in `ng/core/system_prompts.py`, instead of one hard-coded sentence in the loader. The role goes first and the JSON framing is appended afterwards, so a node can reword its own role without breaking the answer parser. Every medium now sends it - the audio path had none, which made it the one card whose answer could not be relied on.
- What a provider can read is now a stated fact (`image yes · audio no`) instead of two checkboxes the user had to get right. The backend checks the provider registry rather than the user's tick, and refuses with the way out named - including the Text card, which needs no provider at all. The CLIP / Encoder card keeps the two switches on purpose: there the model is whatever the user connected, so the setting is honestly a promise rather than a known capability. `custom` keeps its flags for the same reason.
- The `?` texts come from the registry, and a provider may override one sentence where the generic one would describe a control it does not have - a seed on Claude, a token budget that has to be 2000 for reasoning models. Fields also show the name they are sent under, so "Max tokens" on Ollama can be found as `num_predict` in the request log.
- Fixed two defects found while finishing this: `context_routes.py` had the new route block inserted in front of the old one instead of replacing it, leaving every import and all five routes declared twice; and an unused `providers.of_kind()`.
- 363 NG tests (362 pass/one existing Windows skip), core line trace 99.0 %, Legacy 371/371 + 74/74 and five frontend suites unchanged.
- The AI Loader no longer offers a second seed control. ComfyUI attaches a "control after generate" switch to any widget named `seed` unless the schema sets `control_after_generate`, and that check is a nullish fallback - only an explicit False suppresses it. With both that switch and the panel's own "Fixed seed" on screen, one field carried two controls for one decision. The render nodes keep theirs, where the queue really does own the seed.
- A context card now says why it cannot be analysed, in place of an error raised at the far end of the request: the registry's sentence, naming the alternative that needs no provider at all. It appears on the card holding the medium, not on the provider dropdown. Not shown for CLIP / Encoder, where nothing is known about the connected model, nor for a custom address.
- Fixed two further defects found while reviewing: a card's unreadable `context_options` was swallowed by an empty `catch`, placing its audio at 0 s on the timeline without a word; and the CLIP card's capability line reported the abilities of whichever HTTP provider was chosen earlier, which is not the model the request goes to.
- 257 NG tests (256 pass/one Windows skip), all frontend modules parse and the frontend logic tests pass. Legacy 371/371 + 74/74 unchanged.
- Last Frame verified by a real render with the installed int8 FL2VA model: over a 4-second run the output ends 2.19 mean pixel difference from the target picture (start 37.30), while the same run without any context ends at 93.44. The model follows the frame. First Frame, interruption and the continuity-mode comparison are still unmeasured.

**H3 Director NG: a connected Director interface with reusable media contexts.** Local development; no push, tag or publication.
The original timeline Director remains Legacy with its existing node ID and behavior.

- Nine product nodes: H3 AI Loader, Context Connector, Director, Director Output, Context Image/Video/Audio/Text and Render Sequence.
- Connector collects native lazy MODEL/CLIP/VAE links and dynamically growing Context groups. Output exposes native sampler values and a separate complete sequence.
- Director has one interface, idea/settings, media context cards, editable scene cards, separate story/render timelines, generation summary and expandable prompt/audio/advanced panels.
- Generate queues the connected workflow. Sequence expands native StartLoop/List, conditioning, SamplerCustomAdvanced, EndLoop and collection, with native preview/progress/interruption.
- Four compact Context cards open full media workspaces. Image supports multiple content/usage roles and property preservation; timed guides condition the relevant chunk.
  Video has playback/source ranges, motion/camera guidance, last-source-frame continuation and optional paired audio.
  Audio has waveform/playback, draggable source selection/zoom, speaker, copy/lock roles and clearly labeled preview volume/fades.
  Text has a large editor, quick insertion, editable templates/examples and highlighted references.
- Context identity, roles, preservation, timing and colors survive versioned local presets and workflow serialization. Recognized references follow a renamed persistent context.
- Separate optional AI provider: explicit context Analyze/Apply and timed Auto Direct/Apply proposals. Environment-variable credentials; no request on load/connect/render.
- Existing chunk/continuity/planner implementation is reused, including audio lock, shot-aware boundaries, frame-grid and long-chain warnings.
  Technical IDs remain under NG/Technical; old Context data without new fields remain readable.
- Three normal product workflows and updated [guide](docs/NG.md) and [validation record](docs/NG-validation.md).
  186 NG checks (185 passed, one Windows symlink skip), 98.01% executable core-line coverage; Legacy 371/371 and 74/74.

Known limits: one project resolution, H3 at 24 fps, preservation/structure are guidance, Video Continue is a last-frame guide.
Long chains can drift in image/audio; single-seed functional evidence does not establish invisible seams or bit-identical sound.
Listening, broad multi-seed quality, adaptive continuity/crossfades and a full relationship editor remain further work.

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
