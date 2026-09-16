"""Offline checks for minimax_plan.py — the whole planner, no server, no pixels.

`minimax_plan` imports nothing outside the standard library on purpose, so this runs
anywhere:

    python test_plan.py

Every consumer of the planner depends on it agreeing with itself — the Director encodes
what the live COMPILED PROMPT panel shows, and the panel is only trustworthy because both
come through here. That is what these checks protect.

Run it after any change to minimax_plan.py, before committing.
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("minimax_plan",
                                              os.path.join(HERE, "minimax_plan.py"))
plan = importlib.util.module_from_spec(spec)
sys.modules["minimax_plan"] = plan
spec.loader.exec_module(plan)

FPS = 24.0
_results = []


def check(name, got, want):
    ok = got == want
    _results.append((ok, name, got, want))
    return ok


def check_in(name, needle, haystack):
    ok = needle in haystack
    _results.append((ok, name, "present" if ok else "MISSING: %r" % needle, "present"))
    return ok


def check_not_in(name, needle, haystack):
    ok = needle not in haystack
    _results.append((ok, name, "absent" if ok else "PRESENT: %r" % needle, "absent"))
    return ok


def img(start, length, name="a.png", prompt="", end_frame=False, **extra):
    d = {"type": "image", "start": start, "length": length, "imageFile": name,
         "fileName": name, "prompt": prompt, "isEndFrame": end_frame}
    d.update(extra)          # refRole / refKind / refNote / retention
    return d


def tl(segments, ref_mode="OFF", **extra):
    d = {"reference_mode": ref_mode, "prompt_format": "minimax",
         "global_prompt": "a woman walks through a market", "segments": segments}
    d.update(extra)
    return d


def compile(tdata, duration_f=288, **kw):
    return plan.plan_timeline(tdata, 0, duration_f, FPS, **kw)


# ---------------------------------------------------------------- frame grid
check("align_frame_count(0)", plan.align_frame_count(0), 5)
check("align_frame_count(5)", plan.align_frame_count(5), 5)
check("align_frame_count(6)", plan.align_frame_count(6), 22)
check("align_frame_count(96)", plan.align_frame_count(96), 107)
check("align_frame_count(360)", plan.align_frame_count(360), 362)
check("align_frame_count is idempotent",
      plan.align_frame_count(plan.align_frame_count(101)), plan.align_frame_count(101))

# ---------------------------------------------------------------- fmt_seconds
check("fmt_seconds(0)", plan.fmt_seconds(0.0), "0s")
check("fmt_seconds(6)", plan.fmt_seconds(6.0), "6s")
check("fmt_seconds(1.5)", plan.fmt_seconds(1.5), "1.5s")
check("fmt_seconds(1.04) rounds", plan.fmt_seconds(1.04), "1s")

# ---------------------------------------------------------------- mode switch
check("no images -> t2va", compile(tl([]))["mode"], "t2va")
check("opening image -> fl2va", compile(tl([img(0, 144)]))["mode"], "fl2va")
check("refs on -> ref2va", compile(tl([img(0, 144)], ref_mode="ON"))["mode"], "ref2va")
check("ref_mode_from OFF", plan.ref_mode_from({"reference_mode": "OFF"}), False)
check("ref_mode_from ON", plan.ref_mode_from({"reference_mode": "ON"}), True)
check("ref_mode_from missing key", plan.ref_mode_from({}), False)

# ---------------------------------------------------------------- keyframe roles
roles = lambda p: [e["role"] for e in p["events"]]

check("one clip spanning the window is the opening frame, not the closing one",
      roles(compile(tl([img(0, 288)]))), [plan.ROLE_FIRST])
check("two back-to-back images -> first + last",
      roles(compile(tl([img(0, 144, "a.png"), img(144, 144, "b.png")]))),
      [plan.ROLE_FIRST, plan.ROLE_LAST])
check("an image short of the end is a middle",
      roles(compile(tl([img(0, 144, "a.png"), img(144, 141, "b.png")]))),
      [plan.ROLE_FIRST, plan.ROLE_MIDDLE])
check("isEndFrame wins over position",
      roles(compile(tl([img(0, 144, "a.png", end_frame=True)]))), [plan.ROLE_LAST])
check("a third image in the middle stays a middle",
      roles(compile(tl([img(0, 96, "a.png"), img(96, 96, "b.png"), img(192, 96, "c.png")]))),
      [plan.ROLE_FIRST, plan.ROLE_MIDDLE, plan.ROLE_LAST])

# ---------------------------------------------------------------- frame anchors
# A middle is no longer a dead end: it is anchored at the output frame it sits on, through
# core's Add Guide node. The role it was given above does not change — only what is done
# with it — so every check up to here still describes the same planner.
anchors = lambda p: [e.get("anchor_frame") for e in p["events"]]
clips = lambda p: [e.get("anchor_clip_frames") for e in p["events"]]


def vid(start, length, name="v.mp4", **extra):
    d = img(start, length, name, **extra)
    d["type"] = "video"
    return d


def aud(start, length, name="v.wav", **extra):
    d = {"type": "audio", "start": start, "length": length, "audioFile": name,
         "fileName": name}
    d.update(extra)
    return d


def ev(role, start_f, end_f, kind="image", name="m.png"):
    return {"seg": {"fileName": name}, "rel_start_f": start_f, "rel_end_f": end_f,
            "kind": kind, "role": role, "is_end": False}


check("a batch under five frames is one image", plan.anchor_clip_frames(4), 1)
check("nothing to anchor is still one image", plan.anchor_clip_frames(0), 1)
check("five frames is the shortest clip", plan.anchor_clip_frames(5), 5)
check("21 frames falls back to 5", plan.anchor_clip_frames(21), 5)
check("22 is on the grid", plan.anchor_clip_frames(22), 22)
check("a long clip stops at the cap",
      plan.anchor_clip_frames(500), plan.MAX_ANCHOR_CLIP_FRAMES)
check("the cap is itself a legal length",
      plan.MAX_ANCHOR_CLIP_FRAMES % 17, 5)

three = tl([img(0, 96, "a.png"), img(96, 96, "b.png"), img(192, 96, "c.png")])
check("the opening and closing frames carry no anchor of their own",
      [anchors(compile(three))[0], anchors(compile(three))[2]], [None, None])
check("a middle is anchored at its own position", anchors(compile(three))[1], 96)
check("a still anchors one frame", clips(compile(three))[1], 1)
check("an image with nothing but middles still makes the window fl2va",
      compile(tl([img(120, 48, "m.png")]))["mode"], "fl2va")
check("refs on anchors nothing at all",
      anchors(compile(tl([img(0, 96, "a.png"), img(96, 96, "b.png"),
                          img(192, 96, "c.png")], ref_mode="ON"))),
      [None, None, None])

# The timeline runs at the editor's rate and the anchor at the model's 24, so the position
# is a rescale, not a copy: 120 frames into a 30fps timeline is 4s, which is frame 96.
thirty = plan.plan_timeline(tl([img(0, 120, "a.png"), img(120, 120, "b.png"),
                                img(240, 120, "c.png")]), 0, 360, 30.0)
check("an anchor is rescaled to the model's frame rate", anchors(thirty)[1], 96)

check("a timeline video anchors as a clip",
      clips(compile(tl([img(0, 96, "a.png"), vid(96, 96), img(192, 96, "c.png")])))[1],
      plan.MAX_ANCHOR_CLIP_FRAMES)
check("a video too short for a clip anchors as one frame",
      clips(compile(tl([img(0, 96, "a.png"), vid(96, 3), img(192, 96, "c.png")])))[1], 1)
check("a video anchors a clip cut to one of H3's own lengths",
      clips(compile(tl([img(0, 96, "a.png"), vid(96, 12), img(192, 96, "c.png")])))[1], 5)

# anchor_events is exercised directly for the two guards no timeline can reach: the window
# is always shorter than the length it snaps up to, so neither the clamp nor the tail cut
# can fire through plan_timeline.
clamped = [ev(plan.ROLE_MIDDLE, 400, 401)]
plan.anchor_events(clamped, 294, FPS)
check("an anchor past the end lands on the last frame", clamped[0]["anchor_frame"], 293)

tail = [ev(plan.ROLE_MIDDLE, 280, 400, kind="video")]
plan.anchor_events(tail, 294, FPS)
check("a clip is cut to the room left after it", tail[0]["anchor_clip_frames"], 5)

collide = [ev(plan.ROLE_FIRST, 0, 10, name="a.png"), ev(plan.ROLE_MIDDLE, 0, 10, name="b.png")]
skipped = plan.anchor_events(collide, 294, FPS)
check("an image on a frame that is already spoken for is not anchored",
      collide[1].get("anchor_frame"), None)
check("and it is named rather than dropped in silence",
      [s["seg"]["fileName"] for s in skipped], ["b.png"])

# --- the audio track guides as well as fills the mixdown
audio_at = lambda p: [a["anchor_frame"] for a in p["audio_anchors"]]
check("the track is not a guide until it is switched on",
      compile(tl([], audioSegments=[aud(48, 96)]))["audio_anchors"], [])
check("a clip anchors at the second it starts",
      audio_at(compile(tl([], audioSegments=[aud(48, 96)]), use_custom_audio=True)), [48])
check("Override Audio takes the track out of the guides too",
      compile(tl([], audioSegments=[aud(48, 96)]),
              use_custom_audio=True, override_audio=True)["audio_anchors"], [])
check("refs on routes the track to <Audio N> instead",
      compile(tl([], ref_mode="ON", audioSegments=[aud(48, 96)]),
              use_custom_audio=True)["audio_anchors"], [])
locked = compile(tl([], audioSegments=[aud(48, 96), dict(aud(0, 48), retention="lock")]),
                 use_custom_audio=True)
check("a locked clip is held in the audio stream, not anchored as well",
      (audio_at(locked), len(locked["lock_audio_segs"])), ([48], 1))
head = plan.plan_timeline(tl([], audioSegments=[aud(0, 96)]), 24, 288, FPS,
                          use_custom_audio=True)["audio_anchors"]
check("a clip that begins before the window anchors at its first audible frame",
      [(a["anchor_frame"], a["head_trim_f"]) for a in head], [(0, 24.0)])

# --- anchoring is a conditioning fact and nothing else
# Whole strings, not fragments: the point is that not one character of the prompt moved,
# which a substring check cannot say. Harvested before the anchor pass existed.
anchored_tl = tl([img(0, 96, "a.png", prompt="she enters"),
                  img(96, 96, "b.png", prompt="she turns"),
                  img(192, 96, "c.png", prompt="she leaves")])
check("anchoring does not touch the fl2va prompt",
      compile(anchored_tl)["prompt"],
      "How the reference pictures align with the target video — Picture 1 (from Shot 1) "
      "aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 3) aligns "
      "with the 12.25-second mark of the target video.\n\nintegrated_multimodal_description: "
      "a woman walks through a market [Shot 1] she enters [Shot 2] At 00:04.000, she turns "
      "[Shot 3] At 00:08.000, she leaves\n\nnon_diegetic_music: N/A")
check("and it does not touch the ref2va prompt either",
      compile(tl([img(0, 96, "a.png", prompt="she enters"),
                  img(96, 96, "b.png", prompt="she turns"),
                  img(192, 96, "c.png", prompt="she leaves")], ref_mode="ON"))["prompt"],
      "subject_definitions:\n<Picture 1> is the first frame of [Shot 1].\n<Picture 2> is the "
      "first frame of [Shot 2].\n<Picture 3> is the first frame of [Shot 3].\n\nsummary: "
      "[keyframe completion]\n\nretention_analysis:\n<Picture 1> ([Shot 1] first frame): "
      "fully_preserved - the framing and composition of <Picture 1> are retained.\n<Picture 2> "
      "([Shot 2] first frame): fully_preserved - the framing and composition of <Picture 2> "
      "are retained.\n<Picture 3> ([Shot 3] first frame): fully_preserved - the framing and "
      "composition of <Picture 3> are retained.\n\ndetailed_description: a woman walks through "
      "a market [Shot 1] she enters. The shot begins from <Picture 1>. [Shot 2] At 00:04.000, "
      "she turns. The shot begins from <Picture 2>. [Shot 3] At 00:08.000, she leaves. The "
      "shot begins from <Picture 3>.\n\nnon_diegetic_music: N/A")

# ------------------------------------------------- issue #4: ref2va wording
# The reference guide gives the phrasing for concrete frame anchors verbatim: "the shot
# begins from <Picture 1>", "the shot's keyframe corresponds to <Picture 2>", "the shot
# ends on <Picture 3>". FL2VA's "opening frame" / "closing frame" belongs to the other
# guide and must not appear here.
# Reported case: two 6 s images, the second flush with the end of a 12 s window.
flush = compile(tl([img(0, 144, "a.png", prompt="she enters"),
                    img(144, 144, "b.png", prompt="she arrives")], ref_mode="ON"))
short = compile(tl([img(0, 144, "a.png", prompt="she enters"),
                    img(144, 141, "b.png", prompt="she arrives")], ref_mode="ON"))
check_not_in("ref2va never says 'opening frame'", "opening frame", flush["prompt"])
check_not_in("ref2va never says 'closing frame'", "closing frame", flush["prompt"])
check_in("the opening image is declared as a first frame (guide 2.2)",
         "<Picture 1> is the first frame of [Shot 1].", flush["prompt"])
# The reported case: a hard cut. The second image starts shot 2 at 6s; it does not end
# the video, and the fl2va anchor roles are no longer asked.
check_in("the second image opens ITS shot rather than ending the video",
         "<Picture 2> is the first frame of [Shot 2].", flush["prompt"])
check_in("the opening image is also named in the body (guide 5.3)",
         "The shot begins from <Picture 1>.", flush["prompt"])
check_not_in("nothing 'ends on' unless the user said so", "ends on", flush["prompt"])
check("the phrasing no longer depends on where a segment stops",
      flush["prompt"], short["prompt"])
check_not_in("picture notes carry no filenames — the guide has no such notion",
             "a.png", flush["prompt"])

# "ends on" is reserved for a segment explicitly flagged as the end frame
ends = compile(tl([img(0, 144, "a.png", prompt="she enters"),
                   img(144, 144, "b.png", prompt="she arrives", end_frame=True)],
                  ref_mode="ON"))
check_in("an explicit end frame is declared as the last frame",
         "<Picture 2> is the last frame of [Shot 2].", ends["prompt"])
check_in("and says so in the body too (guide 5.3)",
         "The shot ends on <Picture 2>.", ends["prompt"])
check("and it is the slot that takes the segment's last frame",
      [s.get("keyframe") for s in ends["ref_image_slots"]],
      [plan.ROLE_FIRST, plan.ROLE_LAST])
check("without the flag every timeline picture is a shot opener",
      [s.get("keyframe") for s in flush["ref_image_slots"]],
      [plan.ROLE_FIRST, plan.ROLE_FIRST])

# an image whose own segment carries no text has no shot number in the body to point at
noshot = compile(tl([img(0, 144, "a.png"), img(144, 144, "b.png")], ref_mode="ON"))
check_in("an untexted image is a composition anchor, with its time",
         "<Picture 1> is a composition anchor at 0s.", noshot["prompt"])
check_in("and so is one at the end of the timeline",
         "<Picture 2> is a composition anchor at 6s.", noshot["prompt"])
check_not_in("no shot number is invented when the body has none",
             "[Shot", noshot["prompt"])
mixed = compile(tl([img(0, 96, "a.png", prompt="she enters"),
                    img(96, 96, "b.png"),
                    img(192, 96, "c.png", prompt="she leaves")], ref_mode="ON"))
check_in("shot numbers follow the body, which counts only shots with text",
         "<Picture 3> is the first frame of [Shot 2].", mixed["prompt"])
check_in("the untexted middle image falls back to a composition anchor",
         "<Picture 2> is a composition anchor at 4s.", mixed["prompt"])
# the role on the slot picks which frame of a video segment is taken, and whether it is
# fitted to the canvas (minimax_director.py, ref_image_tensors). It follows the same rule
# as the wording, so the prompt describes the frame that actually gets encoded.
check("an image with no text of its own carries no keyframe flag",
      [s.get("keyframe") for s in noshot["ref_image_slots"]], [None, None])
# and that is what keeps it uncropped: a plain reference is not composited into the video,
# so fitting it to the output aspect would throw away reference the model could have used
check("the guide's mid-shot keyframe wording has no image left to describe",
      "keyframe corresponds" in mixed["prompt"], False)

# fl2va must be untouched by that change — there the anchors are real
fl = compile(tl([img(0, 144, "a.png"), img(144, 144, "b.png")]))
check_in("fl2va still emits the alignment instruction",
         "aligns with the 0.00-second mark", fl["prompt"])
check_not_in("fl2va has no <Picture> reference notes", "<Picture", fl["prompt"])

# ------------------------------------------------- issue #6: the S.SS mark
# The alignment line names the effective duration. It must never name a mark past the
# end of the clip it describes, so it is floored to the hundredth, not rounded.
inst = plan.alignment_instruction
check_in("124 frames report 5.16, not 5.17", "5.16-second mark", inst(True, True, 1, 124 / 24.0))
check_not_in("5.17 is outside the video and must not appear",
             "5.17", inst(True, True, 1, 124 / 24.0))
check_in("an exact duration keeps its hundredth", "12.25-second mark",
         inst(True, True, 1, 294 / 24.0))
check_in("8s stays 8.00", "8.00-second mark", inst(True, True, 1, 192 / 24.0))
check_in("the closing-only case floors too", "13.66-second mark",
         inst(False, True, 3, 328 / 24.0))
for frames in (5, 22, 107, 124, 141, 209, 226, 311, 328, 345):
    text = inst(True, True, 1, frames / 24.0)
    mark = float(text.split("aligns with the ")[-1].split("-second")[0])
    check("%d frames: the mark stays inside the video" % frames,
          mark <= frames / 24.0 + 1e-9, True)
check("the opening-only case names no duration at all",
      "second mark" in inst(True, False, 1, 124 / 24.0), False)
check("no keyframe at all yields no instruction", inst(False, False, 1, 5.0), "")

# ---------------------------------------------------------------- reference ordinals
chars = [{"images": [{"b64": "x", "name": "c.png"}], "description": "a woman in a red coat"}]
withchar = compile(tl([img(0, 144, "a.png", prompt="she enters"),
                       img(144, 141, "b.png", prompt="she arrives")],
                      ref_mode="ON", characters=chars))
check("a character takes <Picture 1> ahead of the timeline",
      withchar["ref_image_slots"][0]["source"], "char")
check_in("timeline images number after the character",
         "<Picture 2> is the first frame of [Shot 1].", withchar["prompt"])
check_in("a slot with a description becomes a named subject",
         "<Subject 1> is a woman in a red coat, shown in <Picture 1>.", withchar["prompt"])
check_not_in("a slot image earns no standalone <Picture> entry of its own (guide 2.2)",
             "<Picture 1> is", withchar["prompt"])
check("ref_images input slots sit between character and timeline",
      [s["source"] for s in compile(tl([img(0, 144)], ref_mode="ON", characters=chars),
                                    extra_ref_image_count=2)["ref_image_slots"]],
      ["char", "input", "input", "timeline"])

# issue #8: those input images used to be numbered and never described
described = compile(tl([img(0, 144, "a.png", prompt="she enters")], ref_mode="ON"),
                    extra_ref_image_count=3,
                    ref_image_notes="the kitchen set\n\na storyboard reference for the opening")
check_in("a note describes the input image it belongs to",
         "<Picture 1> is the kitchen set.", described["prompt"])
check_in("a blank line is a placeholder, so line 3 stays with image 3",
         "<Picture 3> is a storyboard reference for the opening.", described["prompt"])
check_not_in("the skipped image gets no invented note", "<Picture 2> is", described["prompt"])
check("described or not, every input image still takes a slot",
      len(described["ref_image_slots"]), 4)
check_not_in("no notes at all means no extra lines",
             "<Picture 1> is the", compile(tl([img(0, 144, "a.png", prompt="x")],
                                              ref_mode="ON"),
                                           extra_ref_image_count=2)["prompt"])
check_in("a trailing full stop in the note is not doubled",
         "<Picture 1> is the kitchen set.",
         compile(tl([img(0, 144, "a.png", prompt="x")], ref_mode="ON"),
                 extra_ref_image_count=1,
                 ref_image_notes="the kitchen set.")["prompt"])
# subject_definitions declares every label and retention_analysis scores every label, so a
# described input image cannot appear in one and be missing from the other
check_in("a described input image is scored like every other declared label",
         "<Picture 1>: fully_preserved - the framing and composition of <Picture 1> are "
         "retained.", described["prompt"])
check_not_in("an undescribed one is neither declared nor scored",
             "<Picture 2>:", described["prompt"])
check_in("and it reaches the comfyui format's flat notes line too",
         "Reference notes: <Picture 1> is the kitchen set",
         compile(tl([img(0, 144, "a.png", prompt="x")], ref_mode="ON",
                    prompt_format="comfyui"),
                 extra_ref_image_count=1,
                 ref_image_notes="the kitchen set")["prompt"])

many = compile(tl([img(i * 20, 20, "%d.png" % i) for i in range(14)], ref_mode="ON"))
check("reference images are capped at the model card's limit",
      len(many["ref_image_slots"]), plan.MAX_REF_IMAGES)

# ---------------------------------------------------------------- @char substitution
sub = compile(tl([img(0, 144, "a.png", prompt="@char1 turns around")],
                 ref_mode="ON", characters=chars))
check_in("@char1 resolves to the subject in ref2va", "<Subject 1> turns around", sub["prompt"])
check_not_in("no raw @char1 survives", "@char1", sub["prompt"])
sub_off = compile(tl([img(0, 144, "a.png", prompt="@char1 turns around")], characters=chars))
check_in("@char1 resolves to the description with refs off",
         "a woman in a red coat turns around", sub_off["prompt"])

nine = [{"images": [{"b64": "x", "name": "%d.png" % i}], "description": "subject %d" % i}
        for i in range(9)]
tags = compile(tl([img(0, 144, "a.png", prompt="@ref9 and @char1 meet")],
                  ref_mode="ON", subjects=nine))
check_in("@ref9 reaches the ninth slot", "<Subject 9> and <Subject 1> meet", tags["prompt"])
check_not_in("no raw @ref tag survives", "@ref", tags["prompt"])

check_in("a slot number that does not exist is left alone",
         "@ref11", compile(tl([img(0, 144, "a.png", prompt="@ref11 waits")],
                              ref_mode="ON", characters=chars))["prompt"])

# ------------------------------------------------- subjects with references off
# references/base-en.txt has no subject_definitions section at all: with refs off a
# subject exists only as prose inside integrated_multimodal_description, established
# "when a speaker first appears" and referred to consistently after that. So the slot's
# description is written out in full at the first mention and abbreviated afterwards —
# otherwise "a middle-aged baker" walks into every shot as a different baker.
BAKER = "a middle-aged baker with a calm, slightly raspy voice"


def base_tl(shots, short_name="the baker", **extra):
    d = {"reference_mode": "OFF", "prompt_format": "minimax",
         "global_prompt": "Live-action, cinematic, a small street bakery before sunrise.",
         "subjects": [{"description": BAKER, "shortName": short_name}],
         "segments": [{"type": "text", "start": i * 120, "length": 120, "prompt": t}
                      for i, t in enumerate(shots)]}
    d.update(extra)
    return d


handled = compile(base_tl(["@ref1 places a fresh loaf on the counter.\n"
                           "@ref1 says: First batch of the morning.",
                           "the camera cuts to a close-up as @ref1 wipes the counter."]),
                  duration_f=240)["prompt"]
check_in("the first mention is written out in full", "[Shot 1] %s places" % BAKER, handled)
check_in("a later mention in the same shot uses the handle",
         "the baker (S1) says, <d>[English] First batch of the morning.</d>", handled)
check_in("a later shot uses the handle too", "as the baker wipes the counter", handled)
check("the description is written exactly once", handled.count(BAKER), 1)

# An empty handle is what every timeline written before the field carried, so it has to
# keep meaning what it meant then: repeat the description at every mention.
repeated = compile(base_tl(["@ref1 places a fresh loaf on the counter.",
                            "@ref1 wipes the counter."], short_name=""),
                   duration_f=240)["prompt"]
check("no handle repeats the description", repeated.count(BAKER), 2)

# "First" is a property of the finished video, not of whichever string is being scanned:
# a subject whose first appearance is a spoken line is introduced by that line.
speaks_first = compile(base_tl(["@ref1 says: First batch of the morning.",
                                "@ref1 wipes the counter."]), duration_f=240)["prompt"]
check_in("a subject introduced by its own dialogue is named in full there",
         "%s (S1) says," % BAKER, speaks_first)
check_in("and abbreviated in the prose that follows", "the baker wipes", speaks_first)

# Same rule with references on, for a slot with no picture behind it: there is no
# <Subject N> label to lean on there either, so the prose has to carry the identity.
noref = compile({"reference_mode": "ON", "prompt_format": "minimax", "global_prompt": "",
                 "subjects": [{"description": BAKER, "shortName": "the baker"}],
                 "segments": [{"type": "text", "start": 0, "length": 120,
                               "prompt": "@ref1 opens the shutters."},
                              {"type": "text", "start": 120, "length": 120,
                               "prompt": "@ref1 slices the loaf."}]},
                duration_f=240)["prompt"]
check("an unpictured subject is still established once", noref.count(BAKER), 1)
check_in("and abbreviated after that", "the baker slices the loaf", noref)

# A slot that *does* have a picture already has a stable handle — <Subject 1> — so the
# field is ignored rather than competing with it.
pictured = compile(tl([img(0, 144, "a.png", prompt="@ref1 opens the shutters"),
                       img(144, 144, "b.png", prompt="@ref1 slices the loaf")],
                      ref_mode="ON",
                      subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                 "description": BAKER, "shortName": "the baker"}]))["prompt"]
check_in("a pictured subject keeps its label at the first mention",
         "<Subject 1> opens the shutters", pictured)
check_in("and at every mention after it", "<Subject 1> slices the loaf", pictured)
check_not_in("the handle does not leak into the ref2va path", "the baker", pictured)

check_in("subject images are called out as unsent on the fl2va path",
         "fl2va sends none of them",
         " ".join(compile(tl([img(0, 144)], characters=chars))["ref_warnings"]))

# The whole base-guide prompt: no subject_definitions, no retention_analysis, the section
# name the base guide uses rather than the reference guide's, and the identity carried by
# the prose alone.
BASE_GOLDEN = (
    "integrated_multimodal_description: Live-action, cinematic, a small street bakery "
    "before sunrise. "
    "[Shot 1] %s places a fresh loaf on the counter. "
    "the baker (S1) says, <d>[English] First batch of the morning.</d> "
    "[Shot 2] At 00:05.000, the camera cuts to a close-up as the baker wipes the counter."
    "\n\n"
    "overall_soundscape: Wooden shutters scrape open over a quiet street."
    "\n\n"
    "non_diegetic_music: N/A" % BAKER)
check("the whole refs-off prompt matches the base guide",
      compile(base_tl(["@ref1 places a fresh loaf on the counter.\n"
                       "@ref1 says: First batch of the morning.",
                       "the camera cuts to a close-up as @ref1 wipes the counter."],
                      overall_soundscape="Wooden shutters scrape open over a quiet street.",
                      non_diegetic_music="N/A"),
              duration_f=240)["prompt"], BASE_GOLDEN)

# ------------------------------------------------- the base guide's field list is closed
# "Part Two: Three Core Fields (Required, in this order)" — and `summary` is not one of
# them. It belongs to the reference guide, so on the fl2va path it would be a section H3
# was never trained to read there. The box keeps its text for when the toolbar goes back.
summary_off = compile(base_tl(["she enters"], summary="a woman walks through a market",
                              task_type_override="video editing"), duration_f=240)
check_not_in("no summary section on the fl2va path", "summary:", summary_off["prompt"])
check_not_in("and no task-type prefix either", "video editing", summary_off["prompt"])
check_in("the same box still reaches the ref2va prompt",
         "summary: [keyframe completion] a woman walks through a market",
         compile(tl([img(0, 144)], ref_mode="ON",
                    summary="a woman walks through a market"))["prompt"])

# non_diegetic_music is required by both guides, and "N/A" is their own value for having
# none. overall_soundscape is not filled in the same way: there "N/A" claims the video was
# asked to be silent, which is a statement only the user can make.
check_in("an empty music box still writes the required field",
         "non_diegetic_music: N/A", compile(tl([img(0, 144)]))["prompt"])
check_in("and so does the reference path",
         "non_diegetic_music: N/A", compile(tl([img(0, 144)], ref_mode="ON"))["prompt"])
check("a prompt is never manufactured out of the default alone",
      plan.plan_timeline({"prompt_format": "minimax"}, 0, 288, FPS)["prompt"], "video")
check_in("an empty soundscape is called out rather than invented",
         "overall_soundscape is empty",
         " ".join(compile(tl([img(0, 144)]))["ref_warnings"]))
check_not_in("and left alone once written", "overall_soundscape is empty",
             " ".join(compile(tl([img(0, 144)],
                                 overall_soundscape="Market chatter."))["ref_warnings"]))

# 350-500 words is the reference guide's figure for its own detailed_description. The base
# guide gives no word count at all, so the fl2va path must not cite one.
long_shot = " ".join(["she walks"] * 300)
check_not_in("no word-count warning on the fl2va path", "350-500",
             " ".join(compile(tl([img(0, 144, prompt=long_shot)]))["ref_warnings"]))
check_in("the reference path still warns past 500 words", "350-500",
         " ".join(compile(tl([img(0, 144, prompt=long_shot)],
                             ref_mode="ON"))["ref_warnings"]))

# ------------------------------------------------- full-reference: the whole prompt
# The one check that pins the *entire* output against references/ref-en.txt: section set
# and order (subject_definitions, summary, retention_analysis, detailed_description, then
# the sound fields), one declaration per label, one retention line per label, the markers
# spelled exactly as the guide's fixed values, and the guide's in-body phrasing for frame
# anchors. Substring checks elsewhere can all pass while the assembled prompt is wrong.
spec_tl = {
    "reference_mode": "ON", "prompt_format": "minimax",
    "global_prompt": "The target video uses a realistic multi-camera sitcom style.",
    "subjects": [
        {"images": [{"b64": "x", "name": "shop.png"}], "kind": "environment",
         "description": "the coffee shop with an exposed brick wall and an orange tufted sofa",
         "retention": "fully_preserved"},
        {"images": [{"b64": "y", "name": "dog.png"}], "kind": "animal",
         "description": "a fluffy white Samoyed with a curved tail",
         "retention": "partially_preserved"}],
    "segments": [img(0, 120, "open.png", prompt="@ref1 is empty except for @ref2 on the sofa"),
                 img(120, 120, "cut.png", prompt="@ref2 lunges for the cookie")],
    "audioSegments": [{"audioFile": "vo.wav", "start": 0, "length": 120,
                       "retention": "fully_copy"}],
    "overall_soundscape": "Soft indoor coffee-shop room tone throughout.",
    "non_diegetic_music": "N/A"}
SPEC_GOLDEN = (
    "subject_definitions:\n"
    "<Subject 1> is the coffee shop with an exposed brick wall and an orange tufted sofa, "
    "shown in <Picture 1>.\n"
    "<Subject 2> is a fluffy white Samoyed with a curved tail, shown in <Picture 2>.\n"
    "<Picture 3> is the first frame of [Shot 1].\n"
    "<Picture 4> is the first frame of [Shot 2].\n"
    "<Audio 1> is a reference audio clip: its signal is reused in the target video."
    "\n\n"
    "summary: [keyframe completion + reference generation + audio reuse]"
    "\n\n"
    "retention_analysis:\n"
    "<Subject 1> (appears in [Shot 1]): fully_preserved - "
    "the layout, furnishing and lighting of <Subject 1> are retained.\n"
    "<Subject 2> (appears in [Shot 1], [Shot 2]): partially_preserved - "
    "<Subject 2> is still used, with some of its defined characteristics changed.\n"
    "<Picture 3> ([Shot 1] first frame): fully_preserved - "
    "the framing and composition of <Picture 3> are retained.\n"
    "<Picture 4> ([Shot 2] first frame): fully_preserved - "
    "the framing and composition of <Picture 4> are retained.\n"
    "<Audio 1>: fully_copy - "
    "<Audio 1> is reused as the target video's complete final audio track."
    "\n\n"
    "detailed_description: The target video uses a realistic multi-camera sitcom style. "
    "[Shot 1] <Subject 1> is empty except for <Subject 2> on the sofa. "
    "The shot begins from <Picture 3>. "
    "[Shot 2] At 00:05.000, <Subject 2> lunges for the cookie. "
    "The shot begins from <Picture 4>."
    "\n\n"
    "overall_soundscape: Soft indoor coffee-shop room tone throughout."
    "\n\n"
    "non_diegetic_music: N/A")
check("the whole full-reference prompt matches the guide",
      compile(spec_tl, duration_f=240, use_custom_audio=True)["prompt"], SPEC_GOLDEN)

# ------------------------------------------------- old timelines still read
# A workflow saved before subject kinds existed writes `characters` and carries neither a
# kind nor a marker. It has to keep planning, and to plan the same way a timeline written
# today with the defaults does — the defaults were chosen to reproduce the old wording.
legacy_segs = [img(0, 144, "a.png", prompt="she enters"),
               img(144, 144, "b.png", prompt="she arrives")]
legacy = compile(tl(legacy_segs, ref_mode="ON",
                    characters=[{"images": [{"b64": "x", "name": "c.png"}],
                                 "description": "a woman in a red coat"}]))
modern = compile(tl(legacy_segs, ref_mode="ON",
                    subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                               "description": "a woman in a red coat",
                               "kind": "person", "retention": "fully_preserved"}]))
check("the old `characters` key plans identically to `subjects`",
      legacy["prompt"], modern["prompt"])
check("`subjects` wins when a timeline somehow carries both",
      compile(tl([], ref_mode="ON",
                 characters=[{"images": [{"b64": "x", "name": "old.png"}],
                              "description": "the old one"}],
                 subjects=[{"images": [{"b64": "y", "name": "new.png"}],
                            "description": "the new one"}]))["prompt"].count("the new one"), 1)
check("a slot with neither kind nor marker still gets both",
      (plan.sanitize_kind(None), plan.sanitize_retention(None)),
      (plan.SUBJECT_KIND_DEFAULT, plan.RETENTION_DEFAULT))

# ------------------------------------------------- retention markers
# "These markers are fixed English values in the output format" — so they are emitted
# verbatim, and anything the editor might send that is not one of them is clamped rather
# than passed through into the prompt.
for marker in plan.RETENTION_VISIBLE:
    got = compile(tl([img(0, 144)], ref_mode="ON",
                     subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                "description": "a woman", "retention": marker}]))["prompt"]
    check_in("%s reaches the prompt verbatim" % marker, ": %s - " % marker, got)
for marker in plan.RETENTION_AUDIO:
    got = compile(tl([img(0, 144)], ref_mode="ON",
                     audioSegments=[{"audioFile": "a.wav", "start": 0, "length": 96,
                                     "retention": marker}]),
                  use_custom_audio=True)["prompt"]
    check_in("audio marker %s reaches the prompt verbatim" % marker,
             "<Audio 1>: %s - " % marker, got)

check("an invented marker is clamped, never emitted",
      plan.sanitize_retention("very_strongly_preserved"), plan.RETENTION_DEFAULT)
check("a visible marker is rejected on an audio label",
      plan.sanitize_retention("attribute_transfer", audio=True), plan.RETENTION_AUDIO_DEFAULT)
check("an audio marker is rejected on a visible label",
      plan.sanitize_retention("fully_copy"), plan.RETENTION_DEFAULT)
check("markers are matched case-insensitively",
      plan.sanitize_retention("Weak_Reference"), "weak_reference")
bogus = compile(tl([img(0, 144)], ref_mode="ON",
                   subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                              "description": "a woman", "retention": "make_it_pop"}]))
check_not_in("the invented marker never appears", "make_it_pop", bogus["prompt"])

# a hand-written note replaces the generated one, and is punctuated if it wasn't
noted = compile(tl([img(0, 144)], ref_mode="ON",
                   subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                              "description": "a woman", "retention": "attribute_transfer",
                              "retentionNote": "her coat colour moves to the stallholder"}]))
check_in("a written retention note wins over the generated one",
         "attribute_transfer - her coat colour moves to the stallholder.", noted["prompt"])

# ------------------------------------------------- written retention notes
# The guide's own retention lines name the subject's actual features rather than a stock
# phrase — "the Samoyed's thick white fur, pointed ears, dark nose, and curved tail are
# retained". Every reference type has to be able to say that.
noted_pic = compile(tl([img(0, 144, "a.png", prompt="she enters",
                            refNote="the doorway framing and the rain on the glass")],
                       ref_mode="ON"))
check_in("a written note replaces a picture's generated sentence",
         "<Picture 1> ([Shot 1] first frame): fully_preserved - the doorway framing and "
         "the rain on the glass.", noted_pic["prompt"])

noted_vid = compile(tl([], ref_mode="ON",
                       motionSegments=[{"videoFile": "v.mp4", "fileName": "v.mp4",
                                        "start": 0, "length": 120,
                                        "retention": "partially_preserved",
                                        "refNote": "the slow push-in is kept, the handheld "
                                                   "drift is not"}]))
check_in("a written note replaces a reference video's generated sentence",
         "<Video 1> (motion and camera work): partially_preserved - the slow push-in is "
         "kept, the handheld drift is not.", noted_vid["prompt"])

noted_aud = compile(tl([], ref_mode="ON",
                       audioSegments=[{"audioFile": "a.wav", "start": 0, "length": 96,
                                       "retention": "reference",
                                       "refNote": "the speaker's measured delivery guides "
                                                  "the dialogue"}]),
                    use_custom_audio=True)
check_in("a written note replaces an audio clip's generated sentence",
         "<Audio 1>: reference - the speaker's measured delivery guides the dialogue.",
         noted_aud["prompt"])
check("a note already ending in punctuation gains none",
      compile(tl([], ref_mode="ON",
                 subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                            "retentionNote": "Her scar stays on the left cheek!"}])
              )["prompt"].count("cheek!"), 1)

# the exact line the reference guide prints, reproduced end to end
samoyed = compile(tl([img(0, 120, "a.png", prompt="@ref1 lunges for the cookie"),
                      img(120, 120, "b.png", prompt="@ref1 is pulled back")],
                     ref_mode="ON",
                     subjects=[{"images": [{"b64": "x", "name": "dog.png"}],
                                "kind": "animal",
                                "description": "the fluffy white Samoyed",
                                "retention": "fully_preserved",
                                "retentionNote": "the Samoyed's thick white fur, pointed "
                                                 "ears, dark nose, and curved tail are "
                                                 "retained"}]),
                   duration_f=240)
check_in("the guide's own retention line can be reproduced exactly",
         "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the Samoyed's "
         "thick white fur, pointed ears, dark nose, and curved tail are retained.",
         samoyed["prompt"])

# a <Video N> / <Audio N> declaration is prose, so a written one replaces it outright.
# This is the only route to the guide's own shapes, which name things the timeline cannot
# work out: "<Audio 1> is the voice-timbre reference for <Subject 1> (S1)".
spoken = compile(tl([], ref_mode="ON",
                    subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                               "description": "a woman in a red coat"}],
                    audioSegments=[{"audioFile": "vo.wav", "start": 0, "length": 96,
                                    "refDesc": "the voice-timbre reference for "
                                               "<Subject 1> (S1)"}]),
                 use_custom_audio=True)
check_in("an audio clip can name the speaker it belongs to",
         "<Audio 1> is the voice-timbre reference for <Subject 1> (S1).", spoken["prompt"])
check_not_in("its generated declaration is gone, not doubled",
             "is a reference audio clip", spoken["prompt"])
check_in("a reference video's declaration can be written too",
         "<Video 1> is the source video for the target video edit.",
         compile(tl([], ref_mode="ON",
                    motionSegments=[{"videoFile": "v.mp4", "fileName": "v.mp4",
                                     "start": 0, "length": 120,
                                     "refDesc": "the source video for the target video "
                                                "edit"}]))["prompt"])
check("the label is prepended, so it can never be wrong or doubled",
      plan._declaration("<Audio 1>", "the voice reference", "generated"),
      "<Audio 1> is the voice reference.")
check("a sentence pasted with its own label is taken as written",
      plan._declaration("<Audio 1>", "<Audio 1> is the synchronized track of <Video 1>",
                        "generated"),
      "<Audio 1> is the synchronized track of <Video 1>.")
check("nothing written falls back to the generated sentence",
      plan._declaration("<Audio 1>", "   ", "generated"), "generated")

# ------------------------------------------------- speakers and dialogue
# Guide 5.1 and 5.4: speakers carry stable (Sx) IDs assigned by the order of actual vocal
# events in the target video, reused at every later event; dialogue sits inside
# <d>[Language] ...</d>; and a cue inside reused audio names <Audio N> with no invented ID.
prose, spoken = plan.split_dialogue(
    "she jerks her hand back\n@ref1 exclaims with light annoyance: Hey! Watch your dog!")
check("dialogue is lifted out of the prose, leaving a mark where it sat", prose,
      "she jerks her hand back\n" + plan.DIALOGUE_MARK % 0)
check("the tag, delivery and line are read apart",
      (spoken[0]["slot"], spoken[0]["delivery"], spoken[0]["line"]),
      (1, "exclaims with light annoyance", "Hey! Watch your dog!"))
check("English is the default language", spoken[0]["language"], "English")
check("a bare tag still speaks",
      plan.split_dialogue("@ref2: Hello")[1][0]["delivery"], plan.DIALOGUE_DEFAULT_DELIVERY)
check("a language can be named",
      [(e["language"], e["line"]) for e in
       plan.split_dialogue("@ref1 [French] murmure: Bonjour")[1]],
      [("French", "Bonjour")])
check("a tag mid-line is prose, not dialogue",
      plan.split_dialogue("she looks at @ref1: a long pause")[1], [])
check("an unnamed voice carries its own description",
      plan.split_dialogue("@voice(a low male narrator) says: In the beginning")[1][0]["voice"],
      "a low male narrator")

talk = compile(tl([img(0, 72, "a.png", prompt="@ref1 holds a cookie\n"
                                              "@ref1 exclaims with annoyance: Watch your dog!"),
                   img(72, 48, "b.png", prompt="@ref2 says with a playful tone: He likes cookies."),
                   img(120, 120, "c.png", prompt="@ref1 replies: He has good taste.")],
                  ref_mode="ON",
                  subjects=[{"images": [{"b64": "x", "name": "w.png"}],
                             "description": "a young blonde woman"},
                            {"images": [{"b64": "y", "name": "m.png"}],
                             "description": "a young man in a hoodie"}]),
               duration_f=240)
check_in("a speaking subject keeps its label and gains a speaker ID",
         "<Subject 1> (S1) exclaims with annoyance, <d>[English] Watch your dog!</d>",
         talk["prompt"])
check_in("the second speaker is S2", "<Subject 2> (S2) says with a playful tone,",
         talk["prompt"])
check_in("the first speaker keeps S1 when they speak again",
         "<Subject 1> (S1) replies, <d>[English] He has good taste.</d>", talk["prompt"])
check("exactly two speakers were numbered",
      len(set(re.findall(r"\(S\d+\)", talk["prompt"]))), 2)
check_not_in("no speaker ID leaks into retention_analysis",
             "(S", talk["prompt"].split("retention_analysis:")[1].split("detailed_description")[0])
check_in("a subject that speaks counts as appearing in that shot",
         "<Subject 2> (appears in [Shot 2]):", talk["prompt"])

# a shot whose only content is a spoken line is still a shot
only_talk = compile(tl([img(0, 120, "a.png", prompt="she waits"),
                        {"type": "text", "start": 120, "length": 120,
                         "prompt": "@ref1 whispers: at last"}],
                       ref_mode="ON",
                       subjects=[{"images": [{"b64": "x", "name": "w.png"}],
                                  "description": "a woman"}]),
                    duration_f=240)
check_in("a dialogue-only shot is still numbered and kept",
         "[Shot 2] At 00:05.000, <Subject 1> (S1) whispers, <d>[English] at last</d>",
         only_talk["prompt"])

# A shot is not a paragraph followed by its dialogue. The guide's own Shot 1 goes action,
# spoken line, more action, so a line written between two paragraphs has to stay between them.
between = compile(tl([img(0, 288, "a.png",
                          prompt="@ref1: before mid segment\n\nmid segment\n\n"
                                 "@ref1: after mid segment")], ref_mode="ON",
                     global_prompt="global prompt here",
                     subjects=[{"images": [], "description": "a woman"}]))
check_in("a spoken line stays where it was written",
         "[Shot 1] a woman (S1) says, <d>[English] before mid segment</d> mid segment. "
         "The shot begins from <Picture 1>. a woman (S1) says, "
         "<d>[English] after mid segment</d>", between["prompt"])
check("both lines belong to the one speaker",
      len(set(re.findall(r"\(S\d+\)", between["prompt"]))), 1)

# `</d>` is a closing tag, not the end of a sentence — the guide runs the next action straight
# out of it. Everything else gets the full stop the next piece needs.
check("nothing is invented after a spoken line",
      plan.join_shot_pieces(["she waits", "<d>[English] hello</d>", "she turns away"]),
      "she waits. <d>[English] hello</d> she turns away")
check("a piece that already ends on punctuation is left alone",
      plan.join_shot_pieces(["she waits,", "then turns"]), "she waits, then turns")
check("empty pieces are dropped rather than punctuated",
      plan.join_shot_pieces(["", "she waits", "   "]), "she waits")

# Whichever comes first in the shot introduces the subject in full — the "called" name is for
# every mention after that, and a spoken line is a mention like any other.
first_seen = compile(tl([{"type": "text", "start": 0, "length": 288,
                          "prompt": "@ref1: Morning.\n@ref1 wipes the counter"}],
                        subjects=[{"images": [], "description": "a raspy-voiced baker",
                                   "shortName": "the baker"}]))
check_in("a subject introduced by its own spoken line is named in full there",
         "[Shot 1] a raspy-voiced baker (S1) says, <d>[English] Morning.</d> the baker wipes "
         "the counter", first_seen["prompt"])
check_in("and prose that comes first still wins when it does",
         "[Shot 1] a raspy-voiced baker wipes the counter. the baker (S1) says, "
         "<d>[English] Morning.</d>",
         compile(tl([{"type": "text", "start": 0, "length": 288,
                      "prompt": "@ref1 wipes the counter\n@ref1: Morning."}],
                    subjects=[{"images": [], "description": "a raspy-voiced baker",
                               "shortName": "the baker"}]))["prompt"])

check_in("the comfyui format keeps the written order too",
         "she waits. <Picture 1> (S1) says, <d>[English] hello</d> she turns away",
         compile(tl([img(0, 288, "a.png", prompt="she waits\n@ref1: hello\nshe turns away")],
                    ref_mode="ON", prompt_format="comfyui",
                    subjects=[{"images": [{"b64": "x", "name": "w.png"}],
                               "description": "a woman"}]))["prompt"])

# guide 5.4: verbal content inside reused audio has no independent vocal source
bgm = compile(tl([img(0, 240, "a.png", prompt="@audio1: we'll meet again")], ref_mode="ON",
                 audioSegments=[{"audioFile": "song.wav", "start": 0, "length": 240,
                                 "retention": "fully_copy"}]),
              duration_f=240, use_custom_audio=True)
check_in("a line carried by reused audio names its source",
         "<Audio 1> carries <d>[English] we'll meet again</d>", bgm["prompt"])
check_not_in("...and invents no speaker ID for it", "(S1)", bgm["prompt"])

# the comfyui format has no <d> notation, but must not silently drop the line either
cf_talk = compile(tl([img(0, 240, "a.png", prompt="@ref1 says: hello")], ref_mode="ON",
                     prompt_format="comfyui",
                     subjects=[{"images": [{"b64": "x", "name": "w.png"}],
                                "description": "a woman"}]), duration_f=240)
check_in("dialogue survives into the comfyui format", "hello", cf_talk["prompt"])

# ------------------------------------------------- spec warnings
check_in("a speaker ID in a retention note is reported",
         "reserves those for detailed_description",
         " ".join(compile(tl([], ref_mode="ON",
                             subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                        "retentionNote": "her voice (S1) is kept"}])
                          )["ref_warnings"]))
check("a clean timeline reports no speaker-ID warning",
      any("(Sx)" in w for w in talk["ref_warnings"]), False)

# A line meant to be spoken that the dialogue rule did not claim. Reported, never repaired:
# the colon is the rule, and taking quoted text would claim prose that quotes a thing.
check("a quoted line with no colon is a near-miss",
      plan.near_miss_dialogue('@ref1 says "hello sir"'),
      [('@ref1 says "hello sir"', "colon")])
check("...with the delivery and a language in front of it",
      bool(plan.near_miss_dialogue('@ref1 [French] murmure "bonjour"')), True)
check("...and a trailing full stop does not hide it",
      bool(plan.near_miss_dialogue('@ref1 says "hello sir".')), True)
check("@char takes a colon and still does not speak",
      plan.near_miss_dialogue("@char1 says: hello sir"),
      [("@char1 says: hello sir", "alias")])
check("prose that quotes a thing and carries on is left alone",
      plan.near_miss_dialogue('@ref1 reads the sign "Closed" and frowns'), [])
check("so is a quote followed by more action",
      plan.near_miss_dialogue('@ref1 says "hello" while @ref1 waves'), [])
check("so is plain prose", plan.near_miss_dialogue("@ref1 walks to the counter"), [])
check("so is real dialogue", plan.near_miss_dialogue("@ref1 says: hello sir"), [])
check("a tag mid-line is not a near-miss either",
      plan.near_miss_dialogue('she looks at @ref1 and says "hi"'), [])

near = compile(tl([img(0, 144, "a.png", prompt="she waits"),
                   img(144, 144, "b.png", prompt='@ref1 says "hello sir"')], ref_mode="ON",
                  subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                             "description": "a woman"}]), duration_f=288)
check_in("the near-miss names the shot it is in and the shape to write",
         "[Shot 2] `@ref1 says \"hello sir\"` reads as dialogue but has no colon",
         " ".join(near["ref_warnings"]))
check_in("...and says what the line lost by staying prose",
         "no speaker ID, no <d>[Language] …</d>", " ".join(near["ref_warnings"]))
check_in("the line itself is untouched", '<Subject 1> says "hello sir"', near["prompt"])
check("a timeline with real dialogue reports no near-miss",
      any("reads as dialogue" in w for w in talk["ref_warnings"]), False)

# detailed_description is a required core field in both guides, and unlike the soundscape it
# has no N/A: the section is simply absent when nothing was written.
check_in("an empty detailed_description is reported",
         "detailed_description is empty; the guide lists it as a required field",
         " ".join(compile(tl([], ref_mode="ON", global_prompt="",
                             subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                        "description": "a woman"}]))["ref_warnings"]))
check("a timeline that says something is not nagged about it",
      any("detailed_description is empty" in w for w in talk["ref_warnings"]), False)

# The declaration "reuses the same (Sx) but never assigns a new one independently", so a
# subject who never speaks leaves it with nothing to reuse — correct, and baffling unsaid.
silent_voice = compile(tl([img(0, 288, "a.png", prompt="she waits")], ref_mode="ON",
                          subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                     "description": "a woman"}],
                          audioSegments=[{"audioFile": "v.wav", "fileName": "v.wav",
                                          "start": 0, "length": 288, "subject": 1}]),
                       use_custom_audio=True)
check_in("a voice reference for a subject who never speaks is reported",
         "<Audio 1> is the voice of <Subject 1>, who has no spoken line, so the guide's "
         "speaker ID could not be reused in its definition. Write the line as "
         "`@ref1 says: …` to give them one.", " ".join(silent_voice["ref_warnings"]))
check("...and once they speak, nothing is reported",
      any("has no spoken line" in w for w in
          compile(tl([img(0, 288, "a.png", prompt="@ref1 says: hello sir")], ref_mode="ON",
                     subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                "description": "a woman"}],
                     audioSegments=[{"audioFile": "v.wav", "fileName": "v.wav",
                                     "start": 0, "length": 288, "subject": 1}]),
                  use_custom_audio=True)["ref_warnings"]), False)
check("an unbound clip is nobody's voice, so there is nothing to report",
      any("has no spoken line" in w for w in
          compile(tl([img(0, 288, "a.png", prompt="she waits")], ref_mode="ON",
                     subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                "description": "a woman"}],
                     audioSegments=[{"audioFile": "v.wav", "fileName": "v.wav",
                                     "start": 0, "length": 288}]),
                  use_custom_audio=True)["ref_warnings"]), False)
# The word count is a figure in the preview badge, not a warning. The guide's 350-500 is a
# lot for a 5-15s clip, so being under it is the ordinary state here — warning about it
# fired on essentially every timeline, which is how a warnings area stops being read.
long_shots = [img(i * 20, 20, "%d.png" % i, prompt=" ".join(["word"] * 200))
              for i in range(3)]
check_in("only overshooting the range is warned about",
         "the guide suggests 350-500",
         " ".join(compile(tl(long_shots, ref_mode="ON"), duration_f=240)["ref_warnings"]))
ordinary = compile(tl([img(i * 96, 96, "%d.png" % i, prompt="she walks past the stalls")
                       for i in range(3)], ref_mode="ON"), duration_f=288)
check("an ordinary short timeline is not nagged",
      any("guide suggests" in w for w in ordinary["ref_warnings"]), False)
check("...but its word count is still reported", ordinary["description_words"], 21)
check("the count covers the global prompt, shot text and dialogue",
      compile(tl([img(0, 240, "a.png", prompt="she waits\n@ref1 says: hello there")],
                 ref_mode="ON", global_prompt="one two three",
                 subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                            "description": "a woman"}]),
              duration_f=240)["description_words"],
      # "one two three" + "she waits" + "<Subject 1> (S1) says, <d>[English] hello there</d>"
      3 + 2 + 7)
check("the comfyui format reports no count rather than failing",
      compile(tl([img(0, 240, "a.png", prompt="she waits")], ref_mode="ON",
                 prompt_format="comfyui"), duration_f=240)["description_words"], 0)

# ------------------------------------------------- Analyze output parsing
check("split_analysis reads both labelled lines",
      plan.split_analysis("DESCRIPTION: A fluffy white Samoyed.\n"
                          "RETAINED: thick white fur, pointed ears"),
      ("A fluffy white Samoyed.", "thick white fur, pointed ears"))
check("unlabelled output is all description — where a single blob went before",
      plan.split_analysis("A fluffy white Samoyed with a curved tail."),
      ("A fluffy white Samoyed with a curved tail.", ""))
check("markdown decoration around the labels is tolerated",
      plan.split_analysis("**Description:** A night market.\n**Retained:** neon signage"),
      ("A night market.", "neon signage"))
check("a chatty preamble is dropped once a label appears",
      plan.split_analysis("Sure! Here is the analysis:\nDESCRIPTION: A red coat.\n"
                          "RETAINED: the collar shape"),
      ("A red coat.", "the collar shape"))
check("only one label is fine", plan.split_analysis("DESCRIPTION: just this"),
      ("just this", ""))
check("a multi-line section is joined",
      plan.split_analysis("RETAINED: the fur\nand the tail")[1], "the fur and the tail")
check("split_analysis on empty text", plan.split_analysis(""), ("", ""))

# ------------------------------------------------- subject kinds
# <Subject N> is not a character slot: "people, animals, or objects; scenes, backgrounds,
# or environments; clothing, props, interfaces, or visual effects; styles, actions,
# expressions, or poses".
for kind, noun in (("environment", "the environment"), ("prop", "the prop"),
                   ("style", "the visual style"), ("animal", "the animal")):
    got = compile(tl([img(0, 144)], ref_mode="ON",
                     subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                "kind": kind}]))["prompt"]
    check_in("a %s subject names itself as one" % kind,
             "<Subject 1> is %s shown in <Picture 1>." % noun, got)
check("an unknown kind falls back rather than inventing a noun",
      plan.sanitize_kind("spaceship"), plan.SUBJECT_KIND_DEFAULT)
check_in("a description replaces the kind noun entirely",
         "<Subject 1> is a rain-slicked night market, shown in <Picture 1>.",
         compile(tl([img(0, 144)], ref_mode="ON",
                    subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                               "kind": "environment",
                               "description": "a rain-slicked night market"}]))["prompt"])
check_in("the retained detail follows the kind, not the word 'character'",
         "the palette, texture and grade of <Subject 1> are retained.",
         compile(tl([img(0, 144)], ref_mode="ON",
                    subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                               "kind": "style"}]))["prompt"])

# ------------------------------------------------- image reference roles
# "If an image is used only to define a character, scene, costume, or style, do not create
# a standalone picture entry. Instead, cite the image source inside the corresponding
# <Subject N> definition."
story = compile(tl([img(0, 144, "sb.png", prompt="the crowd parts", refRole="storyboard")],
                   ref_mode="ON"))
check_in("a storyboard image says which shot it plans and what it defines",
         "<Picture 1> is a storyboard reference for [Shot 1], defining its viewpoint, "
         "subject placement, and shot order.", story["prompt"])
check_in("a storyboard image retains planning, not framing",
         "the viewpoint, subject placement and shot order of <Picture 1> are retained.",
         story["prompt"])

subj_role = compile(tl([img(0, 144, "a.png", prompt="she enters"),
                        img(144, 144, "coat.png", prompt="a wide shot", refRole="subject",
                            refKind="clothing", refDesc="a long red wool coat",
                            refNote="the cut and the brass buttons are kept")],
                       ref_mode="ON"))
check_in("a subject-only image is cited inside a subject definition",
         "<Subject 1> is a long red wool coat, shown in <Picture 2>.", subj_role["prompt"])
check_not_in("a subject-only image earns no standalone picture entry",
             "<Picture 2> is", subj_role["prompt"])
# refDesc and refNote are two different sentences in two different sections, and sharing
# one key would mean a subject-defining image could carry one or the other but never both.
check_in("a subject-only image keeps its own retention note as well as its description",
         "<Subject 1>: fully_preserved - the cut and the brass buttons are kept.",
         subj_role["prompt"])
check("a subject-only image is no longer a keyframe",
      subj_role["ref_image_slots"][1].get("keyframe"), None)
check("...while an untouched image still is",
      subj_role["ref_image_slots"][0].get("keyframe"), plan.ROLE_FIRST)
check("an unknown role falls back to the timeline's own reading",
      plan.sanitize_ref_role("interpretive"), plan.REF_ROLE_AUTO)

# ------------------------------------------------- summary task types
prefix = lambda p: p["prompt"].split("summary: ")[1].split("\n")[0] if "summary: " in p["prompt"] else ""
check("a plain keyframe timeline is keyframe completion",
      prefix(compile(tl([img(0, 288, "a.png", prompt="she waits")], ref_mode="ON"))),
      "[keyframe completion]")
check("a slot image with no frame anchor is reference generation",
      prefix(compile(tl([], ref_mode="ON", subjects=chars))), "[reference generation]")
check("copied audio is reuse, referenced audio is reference",
      (prefix(compile(tl([], ref_mode="ON"),
                      use_custom_audio=True)),
       prefix(compile(tl([], ref_mode="ON",
                         audioSegments=[{"audioFile": "a.wav", "start": 0, "length": 96,
                                         "retention": "partially_copy"}]),
                      use_custom_audio=True))),
      ("", "[audio reuse]"))
check("task types combine in the guide's order and never repeat",
      prefix(compile(tl([img(0, 144, "a.png", prompt="she enters"),
                         img(144, 144, "b.png", prompt="a plan", refRole="storyboard")],
                        ref_mode="ON",
                        audioSegments=[{"audioFile": "a.wav", "start": 0, "length": 96}]),
                     use_custom_audio=True)),
      "[keyframe completion + reference generation + audio reference]")
check("a reference video alone never claims video editing",
      prefix(compile(tl([], ref_mode="ON",
                        motionSegments=[{"videoFile": "v.mp4", "fileName": "v.mp4",
                                         "start": 0, "length": 120}]))),
      "[reference generation]")
check("the override replaces the derived prefix",
      prefix(compile(tl([img(0, 144)], ref_mode="ON",
                        task_type_override="video continuation + keyframe completion"))),
      "[video continuation + keyframe completion]")
check("the override tolerates brackets the user typed",
      plan.task_type_prefix([], [], [], "[video editing]"), "[video editing]")
check("refs off writes no task prefix",
      "summary:" in compile(tl([img(0, 144)]))["prompt"], False)
check_in("a written summary follows the prefix",
         "summary: [keyframe completion] She crosses the market.",
         compile(tl([img(0, 288, "a.png", prompt="she waits")], ref_mode="ON",
                    summary="She crosses the market."))["prompt"])

# `summary` is a box like any other: a tag typed in it reached the model as a literal
# "@ref1" before, because only the global prompt and the shot prompts were substituted.
tagged_summary = compile(tl([img(0, 288, "a.png", prompt="@ref1 waits")], ref_mode="ON",
                            subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                       "description": "a woman in a red coat"}],
                            summary="@ref1 crosses the market."))
check_in("a tag in the summary resolves like every other box",
         "summary: [keyframe completion + reference generation] <Subject 1> crosses the "
         "market.", tagged_summary["prompt"])
check_not_in("no raw tag survives into the prompt", "@ref1", tagged_summary["prompt"])

# The guide's section order puts summary above detailed_description, so that is where a
# subject with no picture to lean on is introduced in full — and the shots below it get
# the short handle, not a second introduction.
noimg = compile(tl([img(0, 288, "a.png", prompt="@ref1 waits")], ref_mode="ON",
                   subjects=[{"description": "a middle-aged baker with a raspy voice",
                              "shortName": "the baker"}],
                   summary="@ref1 opens the shop."))
check_in("an imageless subject is introduced in the summary, being first in reading order",
         "summary: [keyframe completion] a middle-aged baker with a raspy voice opens the "
         "shop.", noimg["prompt"])
check_in("and the shot below it uses the short name",
         "[Shot 1] the baker waits.", noimg["prompt"])

# fl2va has no summary section, so substituting one would mark a subject as introduced on
# the strength of a sentence that never gets written out.
noimg_off = compile(tl([img(0, 288, "a.png", prompt="@ref1 waits")],
                       subjects=[{"description": "a middle-aged baker with a raspy voice",
                                  "shortName": "the baker"}],
                       summary="@ref1 opens the shop."))
check_not_in("the hidden summary does not introduce anyone on the fl2va path",
             "the baker waits", noimg_off["prompt"])
check_in("so the shot still carries the full description",
         "a middle-aged baker with a raspy voice waits", noimg_off["prompt"])

# ------------------------------------------------- the cap leaves nothing dangling
# The 12-file cap trims from the back. Every declaration and retention line has to
# describe a reference that survived, and nothing may reference a dropped ordinal.
# 9 images + 3 videos + 3 audios is 15 files, so three must go — audio first, then video,
# then images from the back.
capped = compile(tl([img(i * 20, 20, "%d.png" % i, prompt="shot %d" % i) for i in range(9)],
                    ref_mode="ON",
                    motionSegments=[{"videoFile": "v%d.mp4" % i, "fileName": "v%d.mp4" % i,
                                     "start": 0, "length": 96} for i in range(3)],
                    audioSegments=[{"audioFile": "a%d.wav" % i, "start": 0, "length": 96}
                                   for i in range(3)]),
                 use_custom_audio=True)
total = (len(capped["ref_image_slots"]) + len(capped["ref_video_segs"])
         + len(capped["ref_audio_segs"]))
check("the total-file cap trims to the model card's limit", total, plan.MAX_REF_FILES)
check("audio is dropped before video or images", len(capped["ref_audio_segs"]), 0)
check("the images all survive", len(capped["ref_image_slots"]), plan.MAX_REF_IMAGES)
check_not_in("no dropped audio is left declared", "<Audio 1>", capped["prompt"])

# The per-type caps mean images can never actually be trimmed: images + videos is at most
# 12 on its own, so the excess is never larger than the audio bucket that is emptied
# first. Assert that rather than pretend to test a path nothing can reach — and check
# directly that declarations are built from the surviving slots, which is what makes the
# ordering safe if a cap ever moves.
check("the excess never outgrows the audio bucket that absorbs it",
      [(i, v, a) for i in range(plan.MAX_REF_IMAGES + 1)
       for v in range(plan.MAX_REF_VIDEOS + 1) for a in range(plan.MAX_REF_AUDIOS + 1)
       if i + v + a - plan.MAX_REF_FILES > a], [])

only_two = plan.build_subject_definitions(
    [], [{"source": "timeline", "ref_role": "auto", "picture_role": plan.ROLE_FIRST,
          "kind": "person", "retention": "fully_preserved", "note": "",
          "shot_no": 1, "at": "0s"}], [], [])
check("declarations describe exactly the slots handed in", len(only_two[0]), 1)
check_not_in("nothing is declared for a slot that was trimmed away",
             "<Picture 2>", " ".join(only_two[0]))
# the slot count belongs to the editor, so the tag substitution follows it
check("a fourth slot's tag resolves too",
      plan.substitute_char_tags("@char4 waves", {4: "the dog"}), "the dog waves")
check("double digits are not eaten by the single-digit tag",
      plan.substitute_char_tags("@char10 and @char1",
                                {1: "one", 10: "ten"}), "ten and one")
check("an unresolved tag is left alone",
      plan.substitute_char_tags("@char7 waits", {1: "one"}), "@char7 waits")
many_chars = [{"images": [{"b64": "x", "name": "%d.png" % i}], "description": "subject %d" % i}
              for i in range(1, 6)]
five = compile(tl([img(0, 144, "a.png", prompt="@char5 arrives")], ref_mode="ON",
                  characters=many_chars))
check("five character slots all get a picture",
      [s["source"] for s in five["ref_image_slots"]][:5], ["char"] * 5)
check_in("the fifth slot resolves in a shot prompt", "<Subject 5> arrives", five["prompt"])

# ------------------------------------------------- issue #7: soundscape / music
audio = tl([img(0, 144)], ref_mode="ON")
audio["global_prompt"] = ("a woman walks through a market\n"
                          "Audio: Market chatter and footsteps on stone.\n"
                          "Music: A slow solo piano, no swell.")
lifted = compile(audio)
check_in("an Audio: line becomes overall_soundscape",
         "overall_soundscape: Market chatter and footsteps on stone.", lifted["prompt"])
check_in("a Music: line becomes non_diegetic_music",
         "non_diegetic_music: A slow solo piano, no swell.", lifted["prompt"])
check_not_in("the lifted lines leave the description",
             "Audio: Market chatter", lifted["prompt"].split("overall_soundscape")[0])

passed = compile(tl([img(0, 144)], ref_mode="ON"),
                 soundscape="Quiet indoor room tone throughout.", music="N/A")
check_in("the soundscape parameter fills overall_soundscape",
         "overall_soundscape: Quiet indoor room tone throughout.", passed["prompt"])
check_in("the music parameter fills non_diegetic_music",
         "non_diegetic_music: N/A", passed["prompt"])

both = compile(audio, soundscape="Explicit wins.")
check_in("an explicit parameter beats the lifted line",
         "overall_soundscape: Explicit wins.", both["prompt"])

plain = compile(tl([img(0, 144)], ref_mode="ON"))
check_not_in("no empty soundscape section when there is nothing to say",
             "overall_soundscape:", plain["prompt"])

# the editor's two boxes live in the timeline, so both consumers read one value
from_tl = compile(tl([img(0, 144)], ref_mode="ON",
                     overall_soundscape="Rain on a tin roof throughout.",
                     non_diegetic_music="N/A"))
check_in("the timeline's overall_soundscape reaches the prompt",
         "overall_soundscape: Rain on a tin roof throughout.", from_tl["prompt"])
check_in("the timeline's non_diegetic_music reaches the prompt",
         "non_diegetic_music: N/A", from_tl["prompt"])
check("an explicit argument overrides the timeline",
      "overall_soundscape: Passed in." in
      compile(tl([img(0, 144)], ref_mode="ON",
                 overall_soundscape="From the timeline."),
              soundscape="Passed in.")["prompt"], True)
check("a blank argument does not blank the timeline value",
      "overall_soundscape: From the timeline." in
      compile(tl([img(0, 144)], ref_mode="ON",
                 overall_soundscape="From the timeline."), soundscape="  ")["prompt"], True)
lifted_vs_box = compile(tl([img(0, 144)], ref_mode="ON",
                           overall_soundscape="From the box.",
                           global_prompt="a shot\nAudio: From the prompt line."))
check_in("the box wins over an Audio: line in the prompt",
         "overall_soundscape: From the box.", lifted_vs_box["prompt"])
check("the sound boxes do not switch in retake mode",
      compile({"reference_mode": "ON", "prompt_format": "minimax",
               "overall_soundscape": "One value for the whole timeline.",
               "retakeMode": True,
               "retakeVideo": {"imageFile": "b.mp4", "videoDurationFrames": 480},
               "retakeStart": 0, "retakeLength": 96,
               "retakePrompt": "she stumbles", "segments": []},
              duration_f=96)["prompt"].count("One value for the whole timeline."), 1)

check("split_audio_music leaves a prompt without labels alone",
      plan.split_audio_music("just a description"), ("just a description", "", ""))
check("split_audio_music takes a label only at the start of a line",
      plan.split_audio_music("a car with no audio: here")[1], "")

# ------------------------------------------------- reference video decode budget
# Reference frames are VAE-encoded whole and ride through every sampling step, so the
# decode size is the biggest lever on an out-of-memory render. Lowering the short edge has
# to scale the area with it, not square it away.
check("the default budget is exactly the native canvas",
      int(plan.REF_VIDEO_SHORT_EDGE ** 2 * plan.REF_VIDEO_ASPECT_BUDGET), 768 * 1344)
check("halving the short edge quarters the pixel budget",
      round((384 ** 2) / (768 ** 2), 3), 0.25)
check("the offered sizes start at the native canvas and only go down",
      (plan.REF_VIDEO_SIZES[0],
       list(plan.REF_VIDEO_SIZES) == sorted(plan.REF_VIDEO_SIZES, reverse=True)),
      (plan.REF_VIDEO_SHORT_EDGE, True))
# The loader now honours a trim shorter than the model card's 2s instead of quietly
# extending it back up — so the warning is the only thing left saying it is short.
check_in("a clip trimmed under 2s is reported, not silently extended",
         "H3 wants 2-15s per clip",
         " ".join(compile(tl([], ref_mode="ON",
                             motionSegments=[{"videoFile": "v.mp4", "fileName": "v.mp4",
                                              "start": 0, "length": 24}])
                          )["ref_warnings"]))
# ------------------------------------------- issue #10: whose voice is <Audio N>?
two_chars = [{"images": [{"b64": "x", "name": "c1.png"}], "description": "a woman"},
             {"images": [{"b64": "x", "name": "c2.png"}], "description": "a man"}]


def audio(subject=None):
    seg = {"audioFile": "voice.wav", "fileName": "voice.wav", "start": 0, "length": 288}
    if subject is not None:
        seg["subject"] = subject
    return seg


loose_audio = compile(tl([img(0, 288, "a.png", prompt="they talk")], ref_mode="ON",
                         characters=two_chars, audioSegments=[audio()]),
                      use_custom_audio=True)
check_in("an unassigned clip keeps the general wording",
         "<Audio 1> is a reference audio clip: follow its voice and timbre.",
         loose_audio["prompt"])
check_in("and is scored with no one's name against it",
         "<Audio 1>: reference - the target follows <Audio 1> without copying the original "
         "signal.", loose_audio["prompt"])

bound = compile(tl([img(0, 288, "a.png", prompt="they talk")], ref_mode="ON",
                   characters=two_chars,
                   audioSegments=[audio(subject=2)]),
                use_custom_audio=True)
check_in("a clip tied to a subject uses the guide's own sentence",
         "<Audio 1> is the voice-timbre reference for <Subject 2>.", bound["prompt"])
# a subject who never speaks has no ID to reuse, so the label carries the binding on its own
check_not_in("a silent subject gets no speaker ID", "(S", bound["prompt"])
check_in("and the retention line says whose voice it is",
         "<Audio 1> (voice of <Subject 2>): reference - ", bound["prompt"])

mixed_audio = compile(tl([img(0, 288, "a.png", prompt="they talk")], ref_mode="ON",
                         characters=two_chars,
                         audioSegments=[audio(subject=1), audio()]),
                      use_custom_audio=True)
check_in("one bound clip names its subject",
         "<Audio 1> is the voice-timbre reference for <Subject 1>.",
         mixed_audio["prompt"])
check_in("the other stays general",
         "<Audio 2> is a reference audio clip: follow its voice and timbre.",
         mixed_audio["prompt"])
check_in("and only the bound one is scored against a subject",
         "<Audio 2>: reference - ", mixed_audio["prompt"])
# a written sentence still wins over the derived one, exactly as it does for a video
check_in("a hand-written declaration overrides the binding",
         "<Audio 1> is the gravel in his voice, nothing else.",
         compile(tl([img(0, 288, "a.png", prompt="they talk")], ref_mode="ON",
                    characters=two_chars,
                    audioSegments=[dict(audio(subject=1),
                                        refDesc="the gravel in his voice, nothing else")]),
                 use_custom_audio=True)["prompt"])
check("a subject of 0 or nonsense is treated as unassigned",
      (plan._audio_subject_slot({"subject": 0}), plan._audio_subject_slot({"subject": ""}),
       plan._audio_subject_slot({"subject": "none"}), plan._audio_subject_slot({}),
       plan._audio_subject_slot({"subject": "2"})),
      (None, None, None, None, 2))
# The editor's "Voice of" menu labels itself from this, so it must be the planner's own
# numbering and not the slot numbers: an empty slot 1 makes the image in slot 2 <Subject 1>.
gap = compile(tl([img(0, 288, "a.png", prompt="he waits")], ref_mode="ON",
                 characters=[{"images": [], "description": ""},
                             {"images": [{"b64": "x", "name": "c.png"}],
                              "description": "a man"}]))
check("the slot -> subject map skips slots that hand over no image",
      gap["subject_of_slot"], {2: 1})
check("and it is empty with references off",
      compile(tl([img(0, 288, "a.png", prompt="x")], characters=two_chars))["subject_of_slot"],
      {})
check("a clip pointing at a slot with no images binds nothing",
      "voice-timbre reference" in
      compile(tl([img(0, 288, "a.png", prompt="x")], ref_mode="ON",
                 characters=two_chars, audioSegments=[audio(subject=3)]),
              use_custom_audio=True)["prompt"], False)

# ------------------------------ the declaration reuses the speaker's global ID
# "When an <Audio N> explicitly corresponds to a target speaker, reuse that speaker's global
# ID in the definition." The ID is the speaking order, not the subject number — subject 1
# speaks first here, so the clip bound to subject 2 ends up (S2), which is the guide's own
# <Subject 3> (S1) case seen from the other side.
speaks = tl([img(0, 144, "a.png", prompt="@ref1 says: you first"),
             img(144, 144, "b.png", prompt="@ref2 says: after you")], ref_mode="ON",
            characters=two_chars, audioSegments=[audio(subject=2)])
voiced = compile(speaks, use_custom_audio=True)
check_in("a bound clip ends on the speaker's global ID",
         "<Audio 1> is the voice-timbre reference for <Subject 2> (S2).", voiced["prompt"])
check_in("and the same ID is on the spoken line",
         "<Subject 2> (S2) says, <d>[English] after you</d>", voiced["prompt"])
check_not_in("the ID still stays out of retention_analysis", "(S",
             voiced["prompt"].split("retention_analysis:")[1]
                             .split("detailed_description")[0])

check_in("a copied clip names the ID too",
         "<Audio 1> carries the voice of <Subject 2> (S2): its signal is reused in the "
         "target video.",
         compile(tl([img(0, 144, "a.png", prompt="@ref1 says: you first"),
                     img(144, 144, "b.png", prompt="@ref2 says: after you")], ref_mode="ON",
                    characters=two_chars,
                    audioSegments=[dict(audio(subject=2), retention="fully_copy")]),
                 use_custom_audio=True)["prompt"])

check_in("a hand-written declaration that names the subject gains the ID",
         "<Audio 1> is the gravel in the voice of <Subject 2> (S2).",
         compile(tl([img(0, 144, "a.png", prompt="@ref1 says: you first"),
                     img(144, 144, "b.png", prompt="@ref2 says: after you")], ref_mode="ON",
                    characters=two_chars,
                    audioSegments=[dict(audio(subject=2),
                                        refDesc="the gravel in the voice of <Subject 2>")]),
                 use_custom_audio=True)["prompt"])
check_in("one that writes its own ID is left exactly as typed",
         "<Audio 1> is the voice-timbre reference for <Subject 2> (S2).",
         compile(tl([img(0, 144, "a.png", prompt="@ref1 says: you first"),
                     img(144, 144, "b.png", prompt="@ref2 says: after you")], ref_mode="ON",
                    characters=two_chars,
                    audioSegments=[dict(audio(subject=2),
                                        refDesc="the voice-timbre reference for "
                                                "<Subject 2> (S2)")]),
                 use_custom_audio=True)["prompt"])
check_in("one that names somebody else keeps the ID off it entirely",
         "<Audio 1> is the room the voices were recorded in.",
         compile(tl([img(0, 144, "a.png", prompt="@ref1 says: you first")], ref_mode="ON",
                    characters=two_chars,
                    audioSegments=[dict(audio(subject=1),
                                        refDesc="the room the voices were recorded in")]),
                 use_custom_audio=True)["prompt"])
check_in("a silent subject is not numbered just because somebody else spoke",
         "<Audio 1> is the voice-timbre reference for <Subject 2>.\n",
         compile(tl([img(0, 288, "a.png", prompt="@ref1 says: only me")], ref_mode="ON",
                    characters=two_chars, audioSegments=[audio(subject=2)]),
                 use_custom_audio=True)["prompt"])

# ------------------------------------------- a hand-written prompt replaces the text
base_tl = tl([img(0, 144, "a.png", prompt="she enters"),
              img(144, 141, "b.png", prompt="she arrives")], ref_mode="ON",
             characters=chars)
compiled = compile(base_tl)

over_tl = tl([img(0, 144, "a.png", prompt="she enters"),
              img(144, 141, "b.png", prompt="she arrives")], ref_mode="ON",
             characters=chars, prompt_override_on=True,
             prompt_override="  A single hand-written line.  ")
over = compile(over_tl)

check("the override replaces the prompt", over["prompt"], "A single hand-written line.")
check("and is reported as such", over["prompt_overridden"], True)
check("what the timeline would have produced is still available",
      over["compiled_prompt"], compiled["prompt"])
check("the references are still the timeline's, not the text's",
      [s.get("source") for s in over["ref_image_slots"]],
      [s.get("source") for s in compiled["ref_image_slots"]])
check("shots and length are untouched by the override",
      (len(over["shots"]), over["length"]), (len(compiled["shots"]), compiled["length"]))
check("an override is not a fallback", over["prompt_overridden"] and
      not over["prompt_is_fallback"], True)

check("stored but switched off changes nothing",
      compile(tl([img(0, 144, "a.png", prompt="she enters")], ref_mode="ON",
                 characters=chars, prompt_override="ignored me"))["prompt_overridden"],
      False)
check("switched on but empty falls back to the compiled text",
      compile(tl([img(0, 144, "a.png", prompt="she enters")], ref_mode="ON",
                 characters=chars, prompt_override_on=True,
                 prompt_override="   "))["prompt_overridden"], False)
check("an override works in the comfyui format too",
      compile(tl([img(0, 144, "a.png", prompt="x")], ref_mode="ON",
                 prompt_format="comfyui", prompt_override_on=True,
                 prompt_override="plain text"))["prompt"], "plain text")

# ---------------------------------------------------------------- comfyui format
cf = compile(tl([img(0, 144, "a.png"), img(144, 141, "b.png")], ref_mode="ON",
                prompt_format="comfyui"))
check_in("the comfyui format keeps its own reference-notes line",
         "Reference notes: <Picture 1> is a composition anchor at 0s", cf["prompt"])
check_not_in("the comfyui format has no minimax sections",
             "subject_definitions:", cf["prompt"])

# issue #14: a slot description had nowhere to go in this format and was simply dropped.
# It resolves a tag to the bare <Picture N>, so without a declaration the prompt said
# "<Picture 1> steps out of the doorway" and never once said who that is.
cf_sub = compile(tl([img(0, 144, "a.png", prompt="@char1 steps out")],
                    ref_mode="ON", prompt_format="comfyui", characters=chars))
check_in("a slot description reaches the comfyui format's notes line",
         "Reference notes: <Subject 1> is a woman in a red coat, shown in <Picture 1>",
         cf_sub["prompt"])
check_in("and the shot text still uses the picture label this format resolves to",
         "<Picture 1> steps out", cf_sub["prompt"])
check("the subject is declared exactly once", cf_sub["prompt"].count("a woman in a red coat"), 1)
# subjects come before pictures, so the thing is introduced before the frame that shows it
cf_both = compile(tl([img(0, 144, "a.png", prompt="@char1 steps out")],
                     ref_mode="ON", prompt_format="comfyui", characters=chars),
                  extra_ref_image_count=1, ref_image_notes="the kitchen set")
check("the subject line comes before the picture line",
      cf_both["prompt"].index("<Subject 1> is") < cf_both["prompt"].index("is the kitchen set"),
      True)
# an undescribed slot falls back to its kind noun here exactly as it does in the minimax
# format — the two formats say the same thing about the same slot or one of them is lying
check_in("an undescribed slot falls back to its kind noun",
         "Reference notes: <Subject 1> is the person shown in <Picture 1>",
         compile(tl([img(0, 144, "a.png", prompt="x")], ref_mode="ON",
                    prompt_format="comfyui",
                    characters=[{"images": [{"b64": "x", "name": "c.png"}]}]))["prompt"])
# with no slots at all there is no subject line to add
check_not_in("no slots means no subject line",
             "<Subject 1>",
             compile(tl([img(0, 144, "a.png", prompt="x")], ref_mode="ON",
                        prompt_format="comfyui"))["prompt"])
# the minimax format is unchanged by all of this — it had the section all along
check_in("the minimax format still declares the subject in its own section",
         "subject_definitions:\n<Subject 1> is a woman in a red coat, shown in <Picture 1>.",
         compile(tl([img(0, 144, "a.png", prompt="@char1 steps out")],
                    ref_mode="ON", characters=chars))["prompt"])

check("an unknown format falls back to minimax",
      compile(tl([img(0, 144)], prompt_format="nonsense"))["prompt"],
      compile(tl([img(0, 144)], prompt_format="minimax"))["prompt"])

# ---------------------------------------------------------------- retake
retake_tl = tl([img(0, 288, "a.png", prompt="she walks")], retakeMode=True,
               retakeVideo={"imageFile": "base.mp4", "videoDurationFrames": 480},
               retakeStart=48, retakeLength=96, retakePrompt="she stumbles")
r = plan.retake_state(retake_tl)
check("retake_state reads the marked range", (r["start"], r["length"]), (48, 96))
check("retake_state is None when the mode is off", plan.retake_state(tl([])), None)
check("retake_state is None without a base video",
      plan.retake_state({"retakeMode": True, "retakeVideo": {}}), None)
rp = plan.plan_timeline(retake_tl, 48, 96, FPS)
check_in("the retake prompt replaces the timeline text", "she stumbles", rp["prompt"])
check("a retake counts as having a keyframe", rp["mode"], "fl2va")

# ---------------------------------------------------------------- windowing
check("a segment outside the window is ignored",
      len(compile(tl([img(400, 96)]), duration_f=288)["events"]), 0)
check("overlaps() is half-open at the start",
      plan.overlaps({"start": 288, "length": 96}, 0, 288), False)
check("overlaps() catches a segment straddling the end",
      plan.overlaps({"start": 240, "length": 96}, 0, 288), True)

# ---------------------------------------------------------------- degenerate input
check("an empty timeline still yields a prompt", compile(tl([]))["prompt_is_fallback"], False)
check("no prompt anywhere falls back to 'video'",
      plan.plan_timeline({}, 0, 288, FPS)["prompt"], "video")
check("parse_timeline survives broken json", plan.parse_timeline("{not json"), {})
check("parse_timeline on an empty string", plan.parse_timeline(""), {})
ok_tiny = True
try:
    plan.plan_timeline(tl([img(0, 144)]), 0, 1, FPS)
except Exception:
    ok_tiny = False
check("a one-frame window does not raise", ok_tiny, True)

# ---------------------------------------------------------------- prepend_text (#29)
# Text wired into the node (LoRA trigger words) belongs in front of the scene description,
# not in front of the whole prompt, whose first line is the task statement.
base_prompt = compile(tl([img(0, 144, prompt="she turns")]))["prompt"]
with_trig = compile(tl([img(0, 144, prompt="she turns")]), prepend_text="mytrigger, style_x")["prompt"]
check("prepend_text is in the prompt", "mytrigger, style_x, a woman walks through a market" in with_trig, True)
check("...and the prompt still opens the way it did, with the task statement first",
      with_trig.startswith(base_prompt.split("\n")[0]), True)
check("nothing wired leaves the prompt untouched",
      compile(tl([img(0, 144, prompt="she turns")]), prepend_text="")["prompt"], base_prompt)
check("whitespace-only text is nothing",
      compile(tl([img(0, 144, prompt="she turns")]), prepend_text="  \n ")["prompt"], base_prompt)
check("a trailing comma from the loader does not double up",
      "trig, a woman" in compile(tl([]), prepend_text="trig,")["prompt"], True)
check("trigger words alone still make a prompt",
      "trig" in compile(tl([], global_prompt=""), prepend_text="trig")["prompt"], True)
check("...and it is not the 'video' fallback",
      compile(tl([], global_prompt=""), prepend_text="trig")["prompt_is_fallback"], False)

# ------------------------------------------- audio that never reaches the model
# A clip in the audio lane with References off is carried only by combined_audio. That is
# the design, but it reads as a bug unless the node says so.
aud = {"type": "audio", "start": 0, "length": 120, "audioFile": "v.wav", "fileName": "v.wav"}
warn = lambda **kw: " ".join(compile(tl([img(0, 144, prompt="she speaks")], audioSegments=[aud]), **kw)["ref_warnings"])
check("Refs OFF names the audio clip as unsent", "not sent to the model" in warn(), True)
check("...and says why", "audio track is switched off" in warn(), True)
check("Refs OFF with the audio track on anchors it, so no such warning",
      "not sent to the model" in warn(use_custom_audio=True), False)
check("Refs ON with the audio track off says the track is off",
      "audio track is switched off" in " ".join(compile(tl([img(0, 144)], ref_mode="REF2VA",
                                                         audioSegments=[aud]))["ref_warnings"]), True)
check("Refs ON with the audio track on sends it, so no such warning",
      "not sent to the model" in " ".join(compile(tl([img(0, 144)], ref_mode="REF2VA",
          audioSegments=[aud]), use_custom_audio=True)["ref_warnings"]), False)
check("no audio on the timeline, no warning",
      "not sent to the model" in " ".join(compile(tl([img(0, 144)]))["ref_warnings"]), False)
check("a clip outside the window does not count",
      "not sent to the model" in " ".join(compile(tl([img(0, 144)], audioSegments=[dict(aud, start=900)]))["ref_warnings"]), False)

# --------------------------------------------- audio use per clip: copy, lock (0.3.0)
def aclip(start, length, name, retention=None):
    d = {"type": "audio", "start": start, "length": length, "audioFile": name, "fileName": name}
    if retention:
        d["retention"] = retention
    return d


def ref_plan(clips, **kw):
    kw.setdefault("use_custom_audio", True)
    return compile(tl([img(0, 144)], ref_mode="REF2VA", audioSegments=clips), **kw)


one = ref_plan([aclip(0, 192, "v.wav", "fully_copy")])
check("fully_copy: the sound sections declare the reuse, not N/A",
      "<Audio 1> is directly reused" in one["prompt"] and "non_diegetic_music: N/A" not in one["prompt"], True)
check("fully_copy: overall_soundscape names the clip too", "overall_soundscape: The ambience and any voice in <Audio 1>" in one["prompt"], True)
check("fully_copy: no 'soundscape is empty' warning any more",
      any("overall_soundscape is empty" in w for w in one["ref_warnings"]), False)
check("reference keeps N/A", "non_diegetic_music: N/A" in ref_plan([aclip(0, 192, "v.wav")])["prompt"], True)
mine = ref_plan([aclip(0, 192, "v.wav", "fully_copy")], soundscape="rain on a window", music="solo piano")
check("written sound text wins over the generated lines",
      "rain on a window" in mine["prompt"] and "solo piano" in mine["prompt"]
      and "directly reused" not in mine["prompt"], True)

two = ref_plan([aclip(0, 96, "a.wav", "fully_copy"), aclip(96, 96, "b.wav", "fully_copy")])
check("a second fully_copy is written as partially_copy",
      "<Audio 1>: fully_copy" in two["prompt"] and "<Audio 2>: partially_copy" in two["prompt"], True)
check("...and the user is told", any("only one clip can have it" in w for w in two["ref_warnings"]), True)
check("partial copy: the soundscape says the rest is generated",
      "the rest of the sound is generated" in ref_plan([aclip(0, 96, "a.wav", "partially_copy")])["prompt"], True)

lk = ref_plan([aclip(0, 96, "a.wav", "lock"), aclip(96, 96, "b.wav", "fully_copy")])
check("a locked clip is not a reference", len(lk["ref_audio_segs"]), 1)
check("...it is listed for locking", [s["audioFile"] for s in lk["lock_audio_segs"]], ["a.wav"])
check("...and gets no <Audio N> label", "<Audio 2>" in lk["prompt"], False)
check("...so the copied one is <Audio 1>", "<Audio 1>: fully_copy" in lk["prompt"], True)
check("lock works with References off too",
      len(compile(tl([img(0, 144)], audioSegments=[aclip(0, 96, "a.wav", "lock")]), use_custom_audio=True)["lock_audio_segs"]), 1)
check("a locked clip does not trigger the 'not sent' warning",
      any("not sent to the model" in w for w in compile(tl([img(0, 144)], audioSegments=[aclip(0, 96, "a.wav", "lock")]), use_custom_audio=True)["ref_warnings"]), False)
check("audio track off: nothing is locked",
      compile(tl([img(0, 144)], audioSegments=[aclip(0, 96, "a.wav", "lock")]))["lock_audio_segs"], [])
check("a locked clip outside the window is ignored",
      compile(tl([img(0, 144)], audioSegments=[aclip(900, 96, "a.wav", "lock")]), use_custom_audio=True)["lock_audio_segs"], [])

# ------------------------------ a reference does not have to spend output time (PR #18)
# The model card wants each reference audio clip 10-15s long and H3 renders 4-15s, so three
# clips cannot fit any window it can render. A reference is an input, never composited, so
# where it sits decides only whether an audio clip is *also* part of the muxed soundtrack.
def pclip(i, start, length=360, **extra):
    d = {"audioFile": "a%d.wav" % i, "fileName": "a%d.wav" % i, "start": start, "length": length,
         "audioDurationFrames": length, "trimStart": 0}
    d.update(extra)
    return d


def pvid(i, start, length=96, **extra):
    d = {"videoFile": "v%d.mp4" % i, "fileName": "v%d.mp4" % i, "start": start, "length": length}
    d.update(extra)
    return d


def pplan(**kw):
    extra = kw.pop("extra", {})
    return compile(tl([img(0, 120, "a.png", prompt="she walks")], ref_mode="ON", **extra), duration_f=120, **kw)


parked = pplan(extra={"audioSegments": [pclip(i, i * 360) for i in range(3)]}, use_custom_audio=True)
check("all three reference clips are sent from a 5s window", len(parked["ref_audio_segs"]), 3)
check("...and the output stays inside H3's trained range", parked["length"] <= plan.TRAINED_MAX_FRAMES, True)
check("<Audio 3> is declared from past the window", "<Audio 3> is a reference audio clip" in parked["prompt"], True)
check("a parked clip is not warned about", [w for w in parked["ref_warnings"] if "window" in w], [])

check("Override Audio reports a parked reference video it was counting on",
      "no part of them reaches combined_audio: 'v1.mp4'." in " ".join(
          pplan(extra={"motionSegments": [pvid(0, 0), pvid(1, 360)]}, override_audio=True)["ref_warnings"]), True)
check("...and says nothing when every clip is inside the window",
      any("Override Audio takes" in w for w in pplan(extra={"motionSegments": [pvid(0, 0)]}, override_audio=True)["ref_warnings"]), False)

both = pplan(extra={"motionSegments": [pvid(0, 0)], "audioSegments": [pclip(0, 0), pclip(1, 360)]},
             use_custom_audio=True, override_audio=True)
check("Override Audio wins over the audio track", len(both["ref_audio_segs"]), 0)
check("...so no <Audio N> is left declared", "<Audio 1>" in both["prompt"], False)
check("...and the clips that were not sent are named", "clip: 'a0.wav', 'a1.wav'." in " ".join(both["ref_warnings"]), True)
check("Override Audio with no reference video keeps the clips",
      [c["fileName"] for c in pplan(extra={"audioSegments": [pclip(0, 0), pclip(1, 360)]},
                                   use_custom_audio=True, override_audio=True)["ref_audio_segs"]], ["a0.wav", "a1.wav"])
check("<Audio N> follows the clip's position on the track, parked or not",
      [c["fileName"] for c in pplan(extra={"audioSegments": [pclip(2, 720), pclip(0, 0), pclip(1, 360)]},
                                   use_custom_audio=True)["ref_audio_segs"]], ["a0.wav", "a1.wav", "a2.wav"])

check("all three reference videos are sent from a 5s window",
      len(pplan(extra={"motionSegments": [pvid(i, i * 120, 120) for i in range(3)]})["ref_video_segs"]), 3)
budgeted = pplan(extra={"motionSegments": [pvid(i, i * 144, 144) for i in range(3)]})
check("the 15s video budget still applies to parked clips", [c["fileName"] for c in budgeted["ref_video_segs"]], ["v0.mp4", "v1.mp4"])

capped = pplan(extra={"audioSegments": [pclip(i, i * 360) for i in range(4)]}, use_custom_audio=True)
check("the fourth audio clip does not reach the model", len(capped["ref_audio_segs"]), plan.MAX_REF_AUDIOS)
check("...and the cap names the clip it dropped",
      "H3 takes at most 3 reference audio clips; 'a3.wav' was dropped." in " ".join(capped["ref_warnings"]), True)
check("the video cap names its casualty",
      "H3 takes at most 3 reference video clips; 'v3.mp4' was dropped." in " ".join(
          pplan(extra={"motionSegments": [pvid(i, i * 120, 120) for i in range(4)]})["ref_warnings"]), True)

retake_parked = plan.plan_timeline(
    tl([img(0, 480, "a.png", prompt="she walks")], ref_mode="ON", retakeMode=True,
       retakeVideo={"imageFile": "base.mp4", "videoDurationFrames": 480}, retakeStart=48, retakeLength=96,
       audioSegments=[pclip(0, 0, 96), pclip(1, 360)]),
    48, 96, FPS, use_custom_audio=True)
check("a retake still ignores a clip outside the marked range",
      [c["fileName"] for c in retake_parked["ref_audio_segs"]], ["a0.wav"])

inside = compile(tl([img(0, 288, "a.png", prompt="she walks")], ref_mode="ON",
                    audioSegments=[pclip(i, 0, 96) for i in range(3)]), use_custom_audio=True)
check("position changes nothing about what is declared",
      [ln for ln in inside["prompt"].split("\n") if ln.startswith("<Audio")],
      [ln for ln in parked["prompt"].split("\n") if ln.startswith("<Audio")])

# ------------------------------ issue #10: a voice clip on the subject, not on the timeline
def vchars(v1=None, v2=None):
    out = []
    for i, v in enumerate((v1, v2), 1):
        c = {"images": [{"b64": "x", "name": "c%d.png" % i}], "description": "a person %d" % i}
        if v:
            c["voice"] = {"audioFile": v, "fileName": v, "seconds": 8.0}
        out.append(c)
    return out


vshot = [img(0, 120, "a.png", prompt="they talk")]
v2 = compile(tl(vshot, ref_mode="ON", subjects=vchars(None, "bob.wav")), duration_f=120)
check("a subject's voice is sent with the audio track off", [c["fileName"] for c in v2["ref_audio_segs"]], ["bob.wav"])
check_in("...and is declared as that subject's voice",
         "<Audio 1> is the voice-timbre reference for <Subject 2>.", v2["prompt"])
check_in("...and scored against that subject",
         "<Audio 1> (voice of <Subject 2>): reference - ", v2["prompt"])
check("the clip asks for the whole file, capped at the 15s the model takes",
      v2["ref_audio_segs"][0]["length"], int(plan.REF_AUDIO_MAX_SEC * FPS))
check("it lives off the timeline", v2["ref_audio_segs"][0]["start"], 0)
check("the render does not grow for it", v2["length"] <= plan.TRAINED_MIN_FRAMES + 8 or v2["length"] == compile(
    tl(vshot, ref_mode="ON", subjects=vchars()), duration_f=120)["length"], True)
check("nothing is dropped or left unsent", [w for w in v2["ref_warnings"] if "dropped" in w or "not sent" in w], [])

both_v = compile(tl(vshot, ref_mode="ON", subjects=vchars("amy.wav", "bob.wav")), duration_f=120)
check("two subjects, two voices in slot order", [c["fileName"] for c in both_v["ref_audio_segs"]], ["amy.wav", "bob.wav"])
check_in("the first voice belongs to subject 1",
         "<Audio 1> is the voice-timbre reference for <Subject 1>.", both_v["prompt"])
check_in("the second to subject 2",
         "<Audio 2> is the voice-timbre reference for <Subject 2>.", both_v["prompt"])

off_v = compile(tl(vshot, ref_mode="OFF", subjects=vchars("amy.wav")), duration_f=120)
check("Refs OFF sends no voice", off_v["ref_audio_segs"], [])

noimg = compile(tl(vshot, ref_mode="ON", subjects=[{"images": [], "description": "a woman",
                                                    "voice": {"audioFile": "amy.wav", "fileName": "amy.wav"}}]),
                duration_f=120)
check("a voice on a slot without an image is still sent", len(noimg["ref_audio_segs"]), 1)
check_in("...as a plain voice reference, since there is no subject to tie it to",
         "<Audio 1> is a reference audio clip: follow its voice and timbre.", noimg["prompt"])

junk = compile(tl(vshot, ref_mode="ON", subjects=[{"images": [{"b64": "x", "name": "c.png"}],
                                                    "voice": {"audioFile": "  "}},
                                                   {"images": [], "voice": "amy.wav"}]), duration_f=120)
check("a malformed voice is ignored", junk["ref_audio_segs"], [])

# voices come first, so the cap trims timeline clips before a subject's own voice
capv = compile(tl(vshot, ref_mode="ON", subjects=vchars("amy.wav", "bob.wav"),
                  audioSegments=[pclip(i, i * 360) for i in range(3)]),
               duration_f=120, use_custom_audio=True)
check("voices first, then timeline clips, three in all",
      [c["fileName"] for c in capv["ref_audio_segs"]], ["amy.wav", "bob.wav", "a0.wav"])
check_in("the clips that did not fit are named",
         "H3 takes at most 3 reference audio clips; 'a1.wav' was dropped.", " ".join(capv["ref_warnings"]))

# the audio-track switch is about the timeline lane, not about a subject's voice
lane_off = compile(tl(vshot, ref_mode="ON", subjects=vchars("amy.wav"),
                      audioSegments=[pclip(0, 0, 96)]), duration_f=120)
check("audio track off: the voice is sent, the timeline clip is not",
      [c["fileName"] for c in lane_off["ref_audio_segs"]], ["amy.wav"])
check_in("...and the unsent timeline clip is still reported even though a voice is sent",
         "not sent to the model", " ".join(lane_off["ref_warnings"]))

# Override Audio and reference-video soundtracks: both answer where the sound comes from
ov = compile(tl(vshot, ref_mode="ON", subjects=vchars("amy.wav"), motionSegments=[pvid(0, 0)]),
             duration_f=120, override_audio=True)
check("Override Audio with a reference video drops the voice too", ov["ref_audio_segs"], [])
check_in("...and names it", "'amy.wav'", " ".join(ov["ref_warnings"]))

# ---------------------------------------------------------------- report
failed = [r for r in _results if not r[0]]
for ok, name, got, want in _results:
    if not ok:
        print("FAIL  %s\n        got:  %r\n        want: %r" % (name, got, want))
print("\n%d checks, %d passed, %d failed" %
      (len(_results), len(_results) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
