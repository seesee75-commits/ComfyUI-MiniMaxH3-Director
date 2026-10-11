"""MiniMax H3 Director — a WYSIWYG timeline front-end for MiniMax H3.

The timeline editor (js/minimax_director.js) is a modified version of the LTX Director
editor by WhatDreamsCost (GPL-3.0, see LICENSE), by way of the CS fork by CGlide;
modified in 2026 for MiniMax H3. What changed is everything below the UI, because H3
conditions completely differently from LTX 2.3:

* LTX 2.3 gets per-segment prompts through a Prompt-Relay cross-attention mask.
  H3 is a single-stream packed DiT whose only attention is full self-attention with
  `mask=None` hardcoded, and whose Qwen3-VL text encoder was trained on *storyboard*
  prompts with explicit `[0s-1.5s]` shot markers. So timeline segments are compiled
  into that storyboard form — the model's own native mechanism for timed control,
  and exactly what the official H3 templates do.

* Keyframes: on fl2va the opening and closing image resolve to first_frame / last_frame and
  anything between them is anchored where it sits, through core's Add Guide node (ComfyUI
  0.34.0+) — a timeline video as a short clip rather than a single frame. ref2va has no
  keyframe slot at all, so there an image is a <Picture i> reference unless the user marks
  it a frame anchor, which sends it as a frame instead; a reference video or audio clip can
  be marked the same way.

* Audio: H3 generates native stereo audio jointly with the video. A timeline audio clip
  can be used three ways, chosen per clip: as an <Audio j> reference (the retention marker
  says whether the signal is only followed or copied), or *locked* — encoded into the
  target audio stream and held there, so the video is made around sound the model cannot
  change. Every clip is also on `combined_audio` for muxing, which is the bit-exact copy.

* The reference-video track (the old IC-LoRA track) feeds <Video k> references.

Two conditioning paths, each with its own diffusion weights:
  Refs OFF -> t2va / fl2va  (minimax_h3_fl2va_*)
  Refs ON  -> ref2va        (minimax_h3_ref2va_*)

All timeline interpretation lives in minimax_plan.py so the live prompt preview and the
chain node cannot drift from what actually gets encoded.
"""

import json
import logging
import math

import torch

import comfy.nested_tensor
from comfy_api.latest import io

from . import minimax_media as media
from . import minimax_plan as plan
from .minimax_core import add_guide, core

log = logging.getLogger(__name__)

MODEL_FPS = plan.MODEL_FPS
DEFAULT_W, DEFAULT_H = 1344, 768
# Measured, not assumed: 32x32 renders end to end, 16x16 passes PackedLayout and then dies
# inside the video VAE, and anything under 8 leaves a zero-edged latent that takes core's
# PackedLayout down first. 32 is also H3's own step, which is why divisible_by defaults to
# it — with the defaults this floor is unreachable anyway.
MIN_CANVAS_EDGE = 32


# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------

def _unpack(out):
    """Normalise an io.NodeOutput / tuple / list into a plain tuple."""
    if out is None:
        return ()
    args = getattr(out, "args", None)
    if isinstance(args, (tuple, list)):
        return tuple(args)
    result = getattr(out, "result", None)
    if isinstance(result, (tuple, list)):
        return tuple(result)
    if isinstance(out, (tuple, list)):
        return tuple(out)
    if isinstance(out, dict) and isinstance(out.get("result"), (tuple, list)):
        return tuple(out["result"])
    return (out,)


def _snap(value, multiple):
    # Floor, not round — same as the LTX Director's snap() and media.resize_image(), so a
    # derived edge never grows past the box. 16:9 at height 768 lands on 1344, H3's native
    # canvas, instead of overshooting to 1376.
    return max(multiple, (int(value) // multiple) * multiple)


def lock_audio_latent(latent, encoded, spans, latent_fps):
    """Put already-encoded audio into the target audio stream and hold it there.

    `spans` are (start, end) seconds into the render window, one per locked clip. Inside
    them the noise mask is 0, which the sampler reads as "keep"; everywhere else it is 1
    and the model generates, so the gaps between clips and anything past the last one
    stay the model's. The video half of the mask is all ones — the picture is free.

    The mask has the audio stream's own shape, the same thing core's LTXVConcatAVLatent
    builds; a smaller one is broadcast onto the 24-channel video latent and blacks the
    frames out. `encoded` is cut or zero-padded to the stream's length.
    """
    video, audio = latent["samples"].unbind()
    length = audio.shape[-1]
    held = encoded[..., :length].to(device=audio.device, dtype=audio.dtype)
    if held.shape[-1] < length:
        held = torch.nn.functional.pad(held, (0, length - held.shape[-1]))
    mask = torch.ones_like(audio)
    for start, end in spans:
        first = max(0, int(math.floor(start * latent_fps)))
        last = min(length, int(math.ceil(end * latent_fps)))
        if last > first:
            mask[..., first:last] = 0.0
    out = dict(latent)
    out["samples"] = comfy.nested_tensor.NestedTensor((video, held))
    out["noise_mask"] = comfy.nested_tensor.NestedTensor((torch.ones_like(video), mask))
    return out


def resolve_canvas(mm, custom_width, custom_height, divisible_by, resize_method, first_image):
    """Pick the output canvas.

    With both dimensions set, the widgets are a *box*, not a verdict: the first timeline
    image is run through the chosen resize_method and the canvas becomes whatever comes
    out. That is what the LTX Director does, and it is why 'maintain aspect ratio' with a
    1024x1024 box gives a 16:9 image 1024x576 instead of a squashed square. Every other
    method returns the full box.
    """
    div = max(1, int(divisible_by))
    if custom_width > 0 and custom_height > 0:
        if first_image is not None:
            fitted = media.resize_image(first_image[:1], custom_width, custom_height,
                                        resize_method, div)
            return int(fitted.shape[2]), int(fitted.shape[1])
        return _snap(custom_width, div), _snap(custom_height, div)

    if first_image is not None:
        src_h, src_w = int(first_image.shape[1]), int(first_image.shape[2])
    else:
        src_w, src_h = DEFAULT_W, DEFAULT_H

    if custom_width > 0:
        w = _snap(custom_width, div)
        return w, _snap(src_h * w / max(1, src_w), div)
    if custom_height > 0:
        h = _snap(custom_height, div)
        return _snap(src_w * h / max(1, src_h), div), h

    # H3's own canvas policy: 768 short edge, 768*1344 area cap, per-axis round to 32
    return mm.adapt_canvas(src_w, src_h)


def resolve_size(custom_width, custom_height, width=None, height=None):
    """Let a connected `width`/`height` stand in for the settings panel's box.

    The panel owns `custom_width`/`custom_height` and hides them, so a resolution node
    had no reachable socket to drive them through (issue #14). These two sockets are the
    same automation pattern as start/end/duration, and they carry the same hazard: a
    widget has a minimum, a wire has none, and 0 is what an upstream node hands over when
    its own value was never set. Zero pixels is a mistake worth naming here rather than
    six frames deep in the VAE — leaving the socket unconnected is how you ask for a
    canvas derived from the first image.
    """
    for name, value in (("width", width), ("height", height)):
        if value is None:
            continue
        if int(value) <= 0:
            raise ValueError(
                "MiniMax H3 Director: the connected '%s' is %d. It is an output size in "
                "pixels and has to be positive. Leave the socket unconnected to derive "
                "the canvas from the first image instead, and check the node feeding it "
                "— a value that was never set arrives here as 0." % (name, int(value)))
    if width is not None:
        custom_width = int(width)
    if height is not None:
        custom_height = int(height)
    return int(custom_width), int(custom_height)


def resolve_window(tdata, fps, start_frame, duration_frames,
                   start=None, end=None, duration=None):
    """Resolve the render window, honouring automation inputs and retake mode.

    The automation sockets are the only route by which a nonsensical window reaches this
    node: the widgets carry minimums, a connected input carries none. A `duration` of 0 —
    what an upstream node hands over when its own value was never set — used to clamp to
    one timeline frame and then render five, a fifth of a second, without a word. Refuse
    it by name instead. Whatever breaks downstream on a window that short breaks a long
    way from the wire that caused it, which is the expensive kind of bug to report.
    """
    if start is not None:
        if float(start) < 0:
            raise ValueError(
                "MiniMax H3 Director: the connected 'start' is %.3gs. It is a position in "
                "seconds and cannot be negative." % float(start))
        start_frame = int(round(float(start) * fps))
    if end is not None:
        end_frame = int(round(float(end) * fps))
        if duration is None:
            if end_frame <= start_frame:
                raise ValueError(
                    "MiniMax H3 Director: the connected 'end' (%.3gs) is not after the "
                    "window start (%.3gs), so there is nothing to render. Both are in "
                    "seconds." % (float(end), start_frame / fps))
            duration_frames = end_frame - start_frame
    if duration is not None:
        if float(duration) <= 0:
            raise ValueError(
                "MiniMax H3 Director: the connected 'duration' is %.3gs, so there is "
                "nothing to render. It is a length in seconds — H3's trained range is "
                "4-15s. Check the node feeding it; a value that was never set arrives "
                "here as 0." % float(duration))
        duration_frames = max(1, int(round(float(duration) * fps)))

    retake = plan.retake_state(tdata)
    if retake:
        # the marked range replaces the panel window entirely
        return int(retake["start"]), max(1, int(retake["length"]))
    return int(start_frame), max(1, int(duration_frames))


def _load_event_tensor(ev, fps, win_start):
    """Decode the pixels behind one main-track segment, image or video."""
    seg = ev["seg"]
    if ev["kind"] == "video":
        seg_start = float(seg.get("start", 0))
        trim = float(seg.get("trimStart", 0)) + max(0.0, win_start - seg_start)
        return media.load_video_tensor(seg.get("imageFile", ""), trim / fps,
                                       float(seg.get("length", 1)) / fps)
    return media.load_image_tensor(seg)


def load_ref_image_tensors(slots, fit, ref_images=None):
    """Turn the planner's <Picture i> slots into tensors, in the order it numbered them.

    The slot vocabulary is minimax_plan's, so this is the one place that has to know what
    "char" / "input" / "timeline" mean and which frame of a video segment a keyframe role
    picks out. The chain node grew its own copy of this loop and the two drifted: that one
    ignored the ref_images socket entirely and never fitted a keyframe to the canvas, so a
    chained render silently dropped references the Director would have sent.

    `fit` scales a tensor to the resolved canvas. Only real keyframes go through it — a
    plain reference is not composited into the video, so cropping it to the output aspect
    would throw away reference the model could have used.
    """
    tensors = []
    input_cursor = 0
    for slot in slots:
        source = slot["source"]
        if source == "char":
            img = slot["image"]
            tensors.append(media.load_image_source(img.get("b64", ""), img.get("name", "")))
        elif source == "input":
            # planned from a count the caller supplied, so an unconnected socket here means
            # the plan and the caller disagree — skip rather than index into nothing
            if ref_images is None:
                continue
            tensors.append(ref_images[input_cursor:input_cursor + 1])
            input_cursor += 1
        else:
            tensor = slot["event"]["tensor"]
            if slot.get("keyframe") == plan.ROLE_LAST:
                tensors.append(fit(tensor[-1:]))
            elif slot.get("keyframe"):
                tensors.append(fit(tensor[:1]))
            else:
                tensors.append(tensor[:1])
    return tensors


def load_clip_anchors(video_anchors, fps, win_start):
    """Decode the reference-track clips that were marked as frame anchors.

    A reference video is normally decoded small — 768 short edge, or whatever the clip's own
    refSize says — because it is shown to the model rather than composited. An anchored one
    is a piece of the video, so it is decoded the way a main-track segment is and fitted to
    the canvas afterwards.
    """
    loaded = []
    for anchor in video_anchors:
        seg = anchor["seg"]
        want = anchor.get("anchor_clip_frames") or 1
        trim = (float(seg.get("trimStart", 0)) + float(anchor["head_trim_f"])) / fps
        tensor = media.load_video_tensor(seg.get("videoFile", ""), trim, want / MODEL_FPS)
        if tensor is None or not tensor.shape[0]:
            continue                       # load_video_tensor has already said why
        loaded.append({"seg": seg, "kind": "video", "tensor": tensor,
                       "anchor_frame": anchor["anchor_frame"],
                       "anchor_clip_frames": want})
    return loaded


def anchor_guides(guide, conditioning, latent, anchors, audio_anchors,
                  fit, vae, audio_vae, length, fps):
    """Chain one 'Add Guide for MiniMax H3' per anchored segment onto fl2va conditioning.

    Core answers a guide that does not fit with a ValueError, which arrives after both
    models are in VRAM and takes the whole render with it. So every bound it checks is
    checked here first, on the planner's own numbers — and anything that still goes wrong
    costs that one guide and a line in the log, never the render.

    The tensor is sliced before it is fitted, not after: a ten-second clip decodes to 240
    frames and only the first few are anchored, so fitting first would resize 240 images to
    throw all but five away.
    """
    for ev in anchors:
        idx = int(ev["anchor_frame"])
        tensor = ev["tensor"]
        want = ev.get("anchor_clip_frames") or 1
        # _load_event_tensor decodes the whole segment, trimmed at the head but not at the
        # tail, so a clip that runs past the end of the window arrives longer than the room
        # left for it. The planner capped `want` against the window; this caps it against
        # what actually decoded.
        want = min(want, int(tensor.shape[0]))
        if want > 1:
            want = plan.anchor_clip_frames(min(want, length - idx))
        if idx + want > length:
            log.warning("[MiniMaxDirector] '%s' would anchor past the end of the video "
                        "(frame %d of %d) — skipped.",
                        plan.seg_name(ev["seg"]), idx, length)
            continue
        try:
            conditioning = _unpack(guide.execute(
                positive=conditioning, latent=latent, frame_idx=idx,
                vae=vae, image=fit(tensor[:want])))[0]
        except Exception as e:
            log.warning("[MiniMaxDirector] Could not anchor '%s' at frame %d: %s — the "
                        "render continues without it.", plan.seg_name(ev["seg"]), idx, e)
            continue
        log.info("[MiniMaxDirector] Anchored '%s' at frame %d (%.2fs)%s.",
                 plan.seg_name(ev["seg"]), idx, idx / MODEL_FPS,
                 " as a %d frame clip" % want if want > 1 else "")

    for anchor in audio_anchors:
        if audio_vae is None:
            # Not an error the way it is on the ref2va path: there the whole conditioning
            # is references and a missing VAE means nothing can be sent, while here the
            # video anchors and the mixdown are unaffected and only the guide is lost.
            log.warning("[MiniMaxDirector] The audio track cannot guide the model without "
                        "the audio VAE — connect minimax_h3_audio_vae to 'audio_vae', or "
                        "turn the audio track off. The clips are still mixed into "
                        "combined_audio.")
            break
        seg = dict(anchor["seg"])
        head = float(anchor["head_trim_f"])
        if head > 0:
            # the part of the clip that falls before the window has already been heard
            seg["trimStart"] = float(seg.get("trimStart", 0)) + head
            seg["length"] = max(1.0, float(seg.get("length", 1)) - head)
        clip = media.load_audio_segment(seg, fps)
        if clip is None:
            continue                      # load_audio_segment has already said why
        idx = int(anchor["anchor_frame"])
        try:
            conditioning = _unpack(guide.execute(
                positive=conditioning, latent=latent, frame_idx=idx,
                audio_vae=audio_vae, audio=clip))[0]
        except Exception as e:
            log.warning("[MiniMaxDirector] Could not anchor the audio of '%s' at frame "
                        "%d: %s — the render continues without it.",
                        plan.seg_name(anchor["seg"]), idx, e)
            continue
        log.info("[MiniMaxDirector] Anchored the audio of '%s' at frame %d (%.2fs).",
                 plan.seg_name(anchor["seg"]), idx, idx / MODEL_FPS)
    return conditioning


class _Unconnected:
    """Distinguishes an empty optional socket from a lazy one that is merely unevaluated.

    ComfyUI passes None for both, so a plain `None` default cannot tell them apart.
    """
    def __repr__(self):
        return "<unconnected>"


_UNCONNECTED = _Unconnected()


def pick_model(model_fl2va, model_ref2va, ref_mode_on):
    """Choose the weights the toolbar switch calls for.

    fl2va and ref2va are separate checkpoints, so the switch that changes the conditioning
    path has to change the model too. Connect both and it is automatic; connect one and it
    is used either way, with a warning when that is the wrong one for the current path.
    """
    wanted, other = (model_ref2va, model_fl2va) if ref_mode_on else (model_fl2va, model_ref2va)
    label = "ref2va" if ref_mode_on else "fl2va"
    if wanted is not None:
        return wanted
    if other is not None:
        log.warning("[MiniMaxDirector] The toolbar is on '%s' but no %s model is connected — "
                    "using the other one. Load minimax_h3_%s_* for correct results.",
                    "Refs ON" if ref_mode_on else "Refs OFF", label, label)
        return other
    raise ValueError(
        "MiniMax H3 Director: no model connected. Wire a UNETLoader into 'model (t2v/i2v)' "
        "(minimax_h3_fl2va_*) and/or 'model (ref2v)' (minimax_h3_ref2va_*)."
    )


def _grab_base_frame(video_ref, frame_index, fps):
    """One frame out of the retake base video, by timeline frame index."""
    if frame_index < 0:
        return None
    frames = media.load_video_tensor(video_ref, frame_index / fps, 1.0 / MODEL_FPS)
    if frames is None or frames.shape[0] == 0:
        return None
    return frames[:1]


# --------------------------------------------------------------------------------------
# node
# --------------------------------------------------------------------------------------

class MiniMaxH3Director(io.ComfyNode):
    """Timeline editor -> MiniMax H3 storyboard conditioning + joint AV latent."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxH3DirectorCS",
            display_name="MiniMax H3 Director",
            category="MiniMax H3",
            description=(
                "Visual timeline for MiniMax H3. Segments become a storyboard prompt with "
                "[0s-1.5s] shot markers, timeline images become first/last keyframes (fl2va) "
                "or <Picture i> references (ref2va), the reference-video track becomes "
                "<Video k>, and audio clips become <Audio j> plus a muxable audio output. "
                "Retake Mode regenerates a marked range of a base video between its own "
                "surrounding frames."
            ),
            inputs=[
                # lazy: only the checkpoint the toolbar actually calls for gets loaded.
                # See check_lazy_status below — without it ComfyUI resolves both inputs
                # before the node runs and reads ~42 GB of weights to use half of them.
                io.Model.Input("model", display_name="model (t2v/i2v)", optional=True, lazy=True,
                               tooltip="The fl2va weights (minimax_h3_fl2va_*), used when the "
                                       "toolbar is on 'Refs OFF'. Connect both models and the "
                                       "node loads whichever the toolbar switch calls for — "
                                       "the other one is never read from disk."),
                io.Model.Input("model_ref2va", display_name="model (ref2v)", optional=True, lazy=True,
                               tooltip="The ref2va weights (minimax_h3_ref2va_*), used when the "
                                       "toolbar is on 'Refs ON'. Optional — with only one model "
                                       "connected that one is used either way."),
                io.Clip.Input("clip", tooltip="Qwen3-VL-32B MiniMax text encoder (CLIPLoader type 'minimax')."),
                io.Vae.Input("vae", tooltip="minimax_h3_video_vae — encodes keyframes and references."),
                io.Vae.Input("audio_vae", optional=True,
                             tooltip="minimax_h3_audio_vae. Only needed when audio references are used (ref2va)."),
                io.String.Input(
                    "global_prompt", multiline=True, default="", force_input=True, optional=True,
                    tooltip="Conditions the whole video: style, scene, characters. Written above the storyboard.",
                ),
                io.Float.Input("start_second", default=0.0, min=0.0, max=1000.0, step=0.01,
                               tooltip="Start of the render window, in seconds."),
                io.Float.Input("end_second", default=5.0, min=0.0, max=1000.0, step=0.01,
                               tooltip="End of the render window, in seconds."),
                io.Float.Input("duration_seconds", default=5.0, min=0.1, max=1000.0, step=0.01,
                               tooltip="Render length in seconds. Snapped up to H3's 17k+5 frame grid at 24 fps."),
                io.Int.Input("start_frame", default=0, min=0, max=10000, step=1,
                             tooltip="Start of the render window, in timeline frames."),
                io.Int.Input("end_frame", default=120, min=1, max=10000, step=1,
                             tooltip="End of the render window, in timeline frames."),
                io.Int.Input("duration_frames", default=120, min=1, max=10000, step=1,
                             tooltip="Render length in timeline frames (at the timeline's frame_rate)."),
                io.String.Input("timeline_data", default="",
                                tooltip="JSON state of the timeline editor (auto-managed; do not edit by hand)."),
                io.Boolean.Input("use_custom_audio", default=False, optional=True,
                                 tooltip="ON: timeline audio clips are used as <Audio j> references (ref2va). "
                                         "The mixdown is always available on combined_audio regardless."),
                io.Boolean.Input("use_custom_motion", default=True, optional=True,
                                 tooltip="ON: the reference-video track feeds <Video k> references (ref2va)."),
                io.Boolean.Input("inpaint_audio", default=True, optional=True,
                                 tooltip="Unused on H3 — audio is generated jointly with the video and cannot be inpainted."),
                io.String.Input("local_prompts", multiline=True, default="",
                                tooltip="Auto-populated from the timeline editor."),
                io.String.Input("segment_lengths", default="",
                                tooltip="Auto-populated from the timeline editor (pixel-space frame counts)."),
                io.Float.Input("frame_rate", default=24, min=1, max=240, step=1, optional=True,
                               tooltip="Timeline editing rate. Output is always 24 fps; times are converted via seconds."),
                io.Combo.Input("display_mode", options=["frames", "seconds"], default="seconds", optional=True,
                               tooltip="Show the ruler and segment ranges in frames or seconds."),
                io.String.Input("guide_strength", default="",
                                tooltip="Auto-populated from the timeline editor. H3 has no per-keyframe strength, so it is ignored."),
                io.Int.Input("custom_width", default=0, min=0, max=8192, step=1, optional=True,
                             tooltip="Output width. With height set too this is a BOX: 'maintain aspect ratio' "
                                     "keeps the first image's aspect inside it. 0 = derive from the image."),
                io.Int.Input("custom_height", default=0, min=0, max=8192, step=1, optional=True,
                             tooltip="Output height. See custom_width."),
                io.Combo.Input("resize_method",
                               options=["maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop"],
                               default="crop", optional=True,
                               tooltip="How timeline images are fitted to the output canvas."),
                io.Int.Input("divisible_by", default=32, min=1, max=256, step=1, optional=True,
                             tooltip="Snap output dimensions to this multiple. H3 needs 32."),
                io.Int.Input("img_compression", default=0, min=0, max=100, step=1, optional=True,
                             tooltip="H.264 CRF baked into each keyframe. 0 = off (recommended for H3)."),
                io.Boolean.Input("override_audio", default=False, optional=True,
                                 tooltip="Use the reference video's own soundtrack as the timeline audio."),
                io.Combo.Input("ref_image_size", options=["match", "max"], default="match", optional=True,
                               tooltip="ref2va only. 'match' scales references to the output pixel area (fast); "
                                       "'max' keeps a 2048 px short edge for identity, at real speed cost."),
                io.Float.Input("shift_video", default=12.0, min=0.01, max=100.0, step=0.01, optional=True,
                               tooltip="Video flow sigma shift (H3 default 12.0)."),
                io.Float.Input("shift_audio", default=3.0, min=0.01, max=100.0, step=0.01, optional=True,
                               tooltip="Audio flow sigma shift (H3 default 3.0)."),
                io.Image.Input("ref_images", optional=True,
                               tooltip="Extra <Picture i> references (single image or batch), appended after the "
                                       "character slots. ref2va only."),
                io.String.Input("ref_image_notes", multiline=True, default="", optional=True,
                                tooltip="One line per image on 'ref_images', describing what it "
                                        "is: 'the kitchen set', 'a storyboard reference for the "
                                        "opening'. Without a line the picture is still numbered "
                                        "but the prompt says nothing about it. Blank lines count, "
                                        "so line 3 always belongs to the third image."),
                io.Float.Input("start", force_input=True, optional=True, default=0.0,
                               tooltip="Automation (connection-only). Window start in SECONDS."),
                io.Float.Input("end", force_input=True, optional=True, default=0.0,
                               tooltip="Automation (connection-only). Window end in SECONDS."),
                io.Float.Input("duration", force_input=True, optional=True, default=0.0,
                               tooltip="Automation (connection-only). Render length in SECONDS."),
                io.Int.Input("width", force_input=True, optional=True, default=0,
                             tooltip="Automation (connection-only). Output width in pixels, "
                                     "overriding the settings panel's Width. Wire a resolution "
                                     "node here; leave it unconnected to use the panel."),
                io.Int.Input("height", force_input=True, optional=True, default=0,
                             tooltip="Automation (connection-only). Output height. See width."),
                io.String.Input("prepend_text", force_input=True, optional=True, default="",
                                tooltip="Connection-only. Text put in front of the global prompt — LoRA "
                                        "trigger words from a loader node, say. It is part of the "
                                        "`prompt` output, but the panel's live preview cannot see it."),
            ],
            outputs=[
                io.Model.Output(display_name="model"),
                io.Conditioning.Output(display_name="positive"),
                io.Latent.Output(display_name="latent", tooltip="Joint video+audio latent. Wire to SamplerCustomAdvanced."),
                io.Audio.Output(display_name="combined_audio",
                                tooltip="Timeline audio mixdown. Wire into CreateVideo to replace the generated audio."),
                io.Float.Output(display_name="fps", tooltip="Always 24.0 — H3's native output rate. Wire into CreateVideo."),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Int.Output(display_name="length", tooltip="Frame count actually generated (snapped to the 17k+5 grid)."),
                io.String.Output(display_name="prompt", tooltip="The compiled storyboard prompt that was encoded."),
                io.String.Output(display_name="retake_info",
                                 tooltip="JSON describing the retake window. Wire into MiniMax H3 Retake Stitch "
                                         "to splice the result back into the base video. Empty when retake is off."),
            ],
        )

    # ------------------------------------------------------------ lazy models

    @classmethod
    def check_lazy_status(cls, timeline_data="", model=_UNCONNECTED,
                          model_ref2va=_UNCONNECTED, **_):
        """Ask for the one checkpoint the toolbar switch calls for, and only that one.

        fl2va and ref2va are ~21 GB each. Without this, ComfyUI resolves both inputs
        before execute() runs, so every render reads both from disk to throw one away —
        which is what pushed a 32 GB machine into a page-file crash (issue #2).

        `None` means *connected but not evaluated yet*, so it cannot be used to detect an
        empty socket; that is what the _UNCONNECTED sentinel is for. Same trick core uses
        in comfy_extras/nodes_logic.py.
        """
        ref_on = plan.ref_mode_from(plan.parse_timeline(timeline_data))
        order = ("model_ref2va", "model") if ref_on else ("model", "model_ref2va")
        have = {"model": model, "model_ref2va": model_ref2va}

        for name in order:                       # preferred first, then the fallback
            if have[name] is _UNCONNECTED:
                continue                         # nothing wired here, try the other
            return [name] if have[name] is None else []
        return []                                # neither connected: execute() raises

    # ---------------------------------------------------------------- execute

    @classmethod
    def execute(cls, clip, vae, start_second, end_second, duration_seconds,
                start_frame, end_frame, duration_frames, timeline_data,
                model=None, model_ref2va=None,
                local_prompts="", segment_lengths="", global_prompt="", guide_strength="",
                frame_rate=24, display_mode="seconds",
                custom_width=0, custom_height=0, resize_method="crop",
                divisible_by=32, img_compression=0, audio_vae=None,
                use_custom_audio=False, inpaint_audio=True, use_custom_motion=True,
                override_audio=False, ref_image_size="match",
                shift_video=12.0, shift_audio=3.0, ref_images=None, ref_image_notes="",
                start=None, end=None, duration=None,
                width=None, height=None, prepend_text="") -> io.NodeOutput:

        mm = core()
        tdata = plan.parse_timeline(timeline_data)
        fps = float(frame_rate) if frame_rate else 24.0

        win_start, duration_frames = resolve_window(
            tdata, fps, start_frame, duration_frames, start, end, duration)
        # resolved here, next to the window, so both automation paths are refused in the
        # same place — and before `width`/`height` are reused for the resolved canvas
        box_w, box_h = resolve_size(custom_width, custom_height, width, height)

        extra_refs = 0
        if ref_images is not None:
            try:
                extra_refs = int(ref_images.shape[0])
            except Exception:
                extra_refs = 0

        p = plan.plan_timeline(tdata, win_start, duration_frames, fps,
                               global_prompt=global_prompt,
                               use_custom_motion=use_custom_motion,
                               use_custom_audio=use_custom_audio,
                               override_audio=override_audio,
                               extra_ref_image_count=extra_refs,
                               ref_image_notes=ref_image_notes,
                               prepend_text=prepend_text)

        length = p["length"]
        if length > plan.TRAINED_MAX_FRAMES:
            # Not a limit and never was: nothing here caps the length, and longer windows
            # do render (issue #12). What leaves the model card's 4-15s envelope is the
            # quality, and the clock — attention is quadratic in sequence length, so the
            # render time climbs faster than the video does.
            log.warning("[MiniMaxDirector] %d frames (%.1fs) is past H3's trained range of "
                        "~%d-%d frames (the model card's 4-15s). It renders — expect drift "
                        "or looping, and a render time that climbs faster than the length. "
                        "For a dependable result shorten the timeline, or render it as "
                        "several windows and splice them together.",
                        length, p["actual_seconds"], plan.TRAINED_MIN_FRAMES,
                        plan.TRAINED_MAX_FRAMES)
        elif length < plan.TRAINED_MIN_FRAMES:
            log.info("[MiniMaxDirector] %d frames (%.1fs) is below H3's trained range "
                     "(~%d frames / 5s). Fine for tests, weaker motion than a full shot.",
                     length, p["actual_seconds"], plan.TRAINED_MIN_FRAMES)
        if p["prompt_is_fallback"]:
            log.warning("[MiniMaxDirector] No prompt text on the timeline — falling back to 'video'.")
        for warning in p.get("ref_warnings") or []:
            log.warning("[MiniMaxDirector] %s", warning)

        retake = p["retake"]

        # --- load the pixels the plan calls for ------------------------------------
        for ev in p["events"]:
            ev["tensor"] = _load_event_tensor(ev, fps, win_start)

        first_src = last_src = None
        if retake:
            # anchor on the base video's own frames either side of the marked range
            first_src = _grab_base_frame(retake["video"], retake["start"] - 1, fps)
            tail_index = retake["start"] + retake["length"]
            if not retake["base_frames"] or tail_index < retake["base_frames"]:
                last_src = _grab_base_frame(retake["video"], tail_index, fps)
            if first_src is None and last_src is None:
                log.warning("[MiniMaxDirector] Retake: could not read anchor frames from '%s' "
                            "— falling back to a plain text-to-video window.", retake["video"])
        else:
            for ev in p["events"]:
                if ev["role"] == plan.ROLE_FIRST:
                    first_src = ev["tensor"][:1]
                elif ev["role"] == plan.ROLE_LAST:
                    last_src = ev["tensor"][-1:]

        # --- canvas -----------------------------------------------------------------
        canvas_src = first_src
        if canvas_src is None:
            canvas_src = p["events"][0]["tensor"] if p["events"] else None
        width, height = resolve_canvas(mm, box_w, box_h,
                                       int(divisible_by), resize_method, canvas_src)

        # Core's PackedLayout divides by `math.sqrt(latent_h * latent_w)`, so a zero-edged
        # latent takes it down with a bare "float division by zero" six frames deep, naming
        # nothing that would lead back here. A slightly larger canvas clears that and then
        # fails inside the video VAE instead. Neither is reachable with the default
        # divisible_by of 32; custom_width=4 with divisible_by=1 is (issue #4).
        if width < MIN_CANVAS_EDGE or height < MIN_CANVAS_EDGE:
            raise ValueError(
                "MiniMax H3 Director: the canvas came out %dx%d. H3 needs at least %dpx per "
                "side — below that its VAE has nothing left to work with and the failure "
                "surfaces deep in ComfyUI as a division by zero. Raise custom_width / "
                "custom_height, or raise divisible_by (32 is H3's own step)."
                % (width, height, MIN_CANVAS_EDGE))

        def fit(tensor):
            out = media.resize_image(tensor, width, height, resize_method, int(divisible_by))
            if out.shape[1] != height or out.shape[2] != width:
                # A later image with a different aspect than the one that set the canvas.
                # The canvas is already fixed, so cover-crop it to match exactly — otherwise
                # the core node would stretch the keyframe and distort it.
                out = media.resize_image(out, width, height, "crop", int(divisible_by))
            if int(img_compression) > 0:
                out = media.compress_image(out, int(img_compression))
            return out

        first_frame = fit(first_src) if first_src is not None else None
        last_frame = fit(last_src) if last_src is not None else None

        # --- reference payloads ------------------------------------------------------
        ref_image_tensors, ref_videos, ref_video_audios, ref_audios = [], {}, {}, {}
        if p["ref_mode_on"]:
            ref_image_tensors = load_ref_image_tensors(p["ref_image_slots"], fit, ref_images)

            for i, seg in enumerate(p["ref_video_segs"]):
                idx = len(ref_videos)
                seg_start = float(seg.get("start", 0))
                seg_len = float(seg.get("length", 1))
                # Only a clip that reaches into the window has a head the window cuts off. A
                # clip parked outside it goes whole, on its own trim: the window start is then
                # nothing to do with the clip, and subtracting it would eat the front of a
                # reference for a reason that has no bearing on it.
                offset = (max(0.0, win_start - seg_start)
                          if plan.overlaps(seg, win_start, win_start + duration_frames)
                          else 0.0)
                trim = float(seg.get("trimStart", 0)) + offset
                # The segment's own length is the answer, capped only at the model card's
                # ceiling. It used to be floored at 2s as well, which meant trimming a clip
                # shorter than that silently handed the VAE *more* than was asked for —
                # the opposite of what someone trimming it down is trying to do. The
                # planner already warns when a clip is under the card's 2s minimum.
                clip_sec = min(plan.REF_VIDEO_MAX_SEC, (seg_len - offset) / fps)
                # Reference frames are VAE-encoded whole and then ride through every
                # sampling step, so their resolution is the largest single lever on memory:
                # halving the short edge is roughly a quarter of the footprint. Per clip,
                # because one reference may be carrying a look worth the pixels while
                # another is only carrying a camera move.
                short_edge = int(seg.get("refSize") or plan.REF_VIDEO_SHORT_EDGE)
                frames = media.load_video_tensor(
                    seg["videoFile"], trim / fps, clip_sec,
                    max_short_edge=short_edge,
                    max_pixels=int(short_edge * short_edge * plan.REF_VIDEO_ASPECT_BUDGET))
                if frames.shape[0] < 5:
                    log.warning("[MiniMaxDirector] Reference video '%s' is shorter than 5 "
                                "frames — skipped. The prompt still declares it as "
                                "<Video %d>, so that label and every one after it now name "
                                "a clip the model was not given.", plan.seg_name(seg), i + 1)
                    continue
                ref_videos["ref_video_%d" % idx] = frames
                if override_audio:
                    clip_audio = media.load_audio_segment(
                        {"audioFile": seg["videoFile"], "trimStart": trim,
                         "length": clip_sec * fps}, fps, file_key="audioFile")
                    if clip_audio is not None:
                        ref_video_audios["ref_video_audio_%d" % idx] = clip_audio

            for i, seg in enumerate(p["ref_audio_segs"]):
                clip_audio = media.load_audio_segment(seg, fps)
                if clip_audio is None:
                    # The prompt is already written, and it numbers <Audio N> by the clip's place
                    # on the track. Dropping one in silence therefore does not just lose a
                    # reference: every label from here on names a different clip than the model
                    # was handed. load_audio_segment has already said why this one failed.
                    log.warning("[MiniMaxDirector] Reference audio '%s' could not be loaded — "
                                "the prompt still declares it as <Audio %d>, so that label and "
                                "every one after it now name a clip the model was not given.",
                                plan.seg_name(seg), i + 1)
                    continue
                seconds = clip_audio["waveform"].shape[-1] / float(clip_audio["sample_rate"])
                if seconds < plan.REF_AUDIO_MIN_SEC:
                    log.warning("[MiniMaxDirector] Reference audio '%s' is %.1fs; H3 wants "
                                "%.0f-%.0fs per clip.", plan.seg_name(seg), seconds,
                                plan.REF_AUDIO_MIN_SEC, plan.REF_AUDIO_MAX_SEC)
                ref_audios["ref_audio_%d" % len(ref_audios)] = clip_audio

            if first_frame is not None or last_frame is not None:
                # The core ref2va node takes no first/last frame, so the opening and closing
                # images reach the model the way every other ref2va image does: anchored at
                # their own frame if that is what they are for, described as <Picture i> if
                # they are not.
                log.info("[MiniMaxDirector] ref2va has no first/last keyframe slot — the "
                         "timeline images were anchored or added as <Picture i> references "
                         "instead, depending on what each one is set to.")
                first_frame = last_frame = None

        prompt = p["prompt"]
        log.info("[MiniMaxDirector] %s%s | %dx%d | %d frames (%.2fs @24fps) | %d shots | "
                 "refs: %d img / %d vid / %d audio",
                 p["mode"], " (retake)" if retake else "", width, height, length,
                 p["actual_seconds"], len(p["shots"]),
                 len(ref_image_tensors), len(ref_videos), len(ref_audios))
        # The full storyboard is one to two screens of text; the node's `prompt` output and
        # the COMPILED PROMPT panel both show it, so keep it out of the console by default.
        log.debug("[MiniMaxDirector] prompt:\n%s", prompt)

        # --- conditioning ------------------------------------------------------------
        # Both paths anchor; they differ in what they anchor. fl2va has no other use for a
        # timeline image, so its middles are anchored on sight. ref2va does, so there the
        # user says which images and clips are frames of the video and which are references,
        # and the planner has already sorted them.
        anchors = [e for e in p["events"] if e.get("anchor_frame") is not None]
        audio_anchors = p.get("audio_anchors") or []
        guide = add_guide()
        if p["ref_mode_on"]:
            anchors = anchors + load_clip_anchors(p.get("video_anchors") or [], fps, win_start)
        if (anchors or audio_anchors) and guide is None:
            what = " and ".join(
                x for x in ("%d image(s) or clip(s)" % len(anchors) if anchors else "",
                            "%d audio clip(s)" % len(audio_anchors) if audio_anchors
                            else "") if x)
            log.warning("[MiniMaxDirector] %s would be anchored inside the window, and this "
                        "ComfyUI has no 'Add Guide for MiniMax H3' node to anchor them with "
                        "— it arrived in 0.34.0. They were ignored: update ComfyUI, or set "
                        "them back to references.", what)
            anchors = audio_anchors = []

        if p["ref_mode_on"]:
            if (ref_audios or ref_video_audios) and audio_vae is None:
                raise ValueError(
                    "MiniMax H3 Director: audio references need the audio VAE. Connect "
                    "minimax_h3_audio_vae to the Director's 'audio_vae' input (or turn off "
                    "the audio track / Override Audio, and remove any voice clip from the "
                    "subject slots)."
                )
            out = mm.MiniMaxH3ReferenceToVideo.execute(
                clip=clip, vae=vae, audio_vae=audio_vae, prompt=prompt,
                width=width, height=height, length=length,
                ref_image_size=ref_image_size,
                ref_images={"ref_image_%d" % i: t for i, t in enumerate(ref_image_tensors)} or None,
                ref_videos=ref_videos or None,
                ref_video_audios=ref_video_audios or None,
                ref_audios=ref_audios or None,
            )
        else:
            out = mm.MiniMaxH3ImageToVideo.execute(
                clip=clip, vae=vae, prompt=prompt,
                width=width, height=height, length=length,
                first_frame=first_frame, last_frame=last_frame,
            )

        conditioning, latent = _unpack(out)[:2]

        if p["lock_audio_segs"]:
            if audio_vae is None:
                raise ValueError(
                    "MiniMax H3 Director: an audio clip is set to lock, which encodes it into "
                    "the audio stream and needs the audio VAE. Connect minimax_h3_audio_vae to "
                    "the Director's 'audio_vae' input, or set the clip back to reference.")
            window_frames = max(1, int(round(p["actual_seconds"] * fps)))
            mix = media.build_combined_audio(timeline_data, win_start, window_frames, fps,
                                             only=plan.is_audio_lock)
            encoded, _ = mm._encode_ref_audio(audio_vae, mix)
            spans = []
            for seg in p["lock_audio_segs"]:
                seg_start = float(seg.get("start", 0))
                first = max(seg_start, win_start) - win_start
                last = min(seg_start + float(seg.get("length", 1)), win_start + window_frames) - win_start
                spans.append((first / fps, last / fps))
            latent = lock_audio_latent(latent, encoded, spans, mm.AUDIO_LATENT_FPS)
            log.info("[MiniMaxDirector] %d audio clip(s) locked into the audio stream "
                     "(%s); the model generates the rest.", len(spans),
                     ", ".join("%.2f-%.2fs" % sp for sp in spans))
        # On fl2va the first and last frame have slots of their own in the node above, and
        # everything else is anchored here; on ref2va nothing has a slot and every frame
        # comes through here. Either way it is the conditioning that node returned — Add
        # Guide appends to the same keyframe list, so the two compose.
        if anchors or audio_anchors:
            conditioning = anchor_guides(guide, conditioning, latent, anchors, audio_anchors,
                                         fit, vae, audio_vae, length, fps)

        chosen_model = pick_model(model, model_ref2va, p["ref_mode_on"])
        patched_model = _unpack(mm.MiniMaxH3SigmaShift.execute(
            model=chosen_model, shift_video=float(shift_video),
            shift_audio=float(shift_audio)))[0]

        audio_out = media.build_combined_audio(
            timeline_data, win_start,
            max(1, int(round(p["actual_seconds"] * fps))), fps, override_audio=override_audio)

        retake_info = ""
        if retake:
            retake_info = json.dumps({
                "base_video": retake["video"],
                "timeline_fps": fps,
                "start_frame": retake["start"],
                "length_frames": retake["length"],
                "base_frames": retake["base_frames"],
                "generated_frames": length,
                "generated_fps": MODEL_FPS,
                "width": int(width), "height": int(height),
            })

        return io.NodeOutput(patched_model, conditioning, latent, audio_out,
                             MODEL_FPS, int(width), int(height), int(length), prompt,
                             retake_info)


NODE_CLASS_MAPPINGS = {"MiniMaxH3DirectorCS": MiniMaxH3Director}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3DirectorCS": "MiniMax H3 Director"}
