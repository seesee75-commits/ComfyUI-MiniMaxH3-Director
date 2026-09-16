"""Render a timeline longer than one H3 shot, as a chain of anchored windows.

WITHDRAWN — this node is not registered in __init__.py and does not appear in the menu.

The sampling here works; it was verified against a live server, one window per toolbar
mode, correct frame counts. What does not work is *giving it a timeline*. The editor in
js/minimax_director.js attaches only to MiniMaxH3DirectorCS, the Director has no
timeline_data output to wire from, and on the Director that widget is hidden
(HIDDEN_WIDGET_NAMES). The only route left was: right-click the Director, open
Properties, copy a multi-kilobyte JSON blob, paste it here — and repeat after every
edit to the timeline.

Two things would have to change before this ships again:
  1. a timeline_data output on the Director, so one wire keeps the two in sync;
  2. a decision about the design itself. Swallowing the sampler and both decoders costs
     the live preview, per-window progress, clean interruption, and duplicates half the
     Director's canvas settings. Long-form video deserves its own interaction model
     rather than being bolted onto this one.

Frame anchors are deliberately not here either: this node still resolves a timeline image
to first_frame / last_frame and nothing else, the way the Director did before it learned to
anchor a middle one. Adding them to a node no one can hand a timeline to would be code that
cannot be run, let alone tested.

Seam quality is also resolution-bound: measured error at the join was 5.2x the median
frame-to-frame difference at 480x288, and 2.3x at 1024x576.

--- what it was meant to do -------------------------------------------------------

MiniMax H3 is trained for roughly 5 to 15 seconds (124-362 frames at 24 fps). Past that
it drifts, loops, or runs out of VRAM. This node renders a long timeline as a sequence of
in-range windows instead: each window is planned from the same timeline, and every window
after the first opens on the previous window's final frame, so the cut is continuous.

Sampling happens inside the node — it takes a SAMPLER and SIGMAS like
SamplerCustomAdvanced does — because the anchor for window N+1 does not exist until
window N has been decoded, which a static graph cannot express.

Everything about *what* each window means comes from minimax_plan, the same planner the
Director uses, so a chained render and a single-window render read the timeline
identically.
"""

import logging

import torch

import comfy.model_management
import comfy.utils
from comfy_api.latest import io

from . import minimax_director as director
from . import minimax_media as media
from . import minimax_plan as plan
from .minimax_core import audio_nodes, core, samplers

log = logging.getLogger(__name__)

MODEL_FPS = plan.MODEL_FPS
AUDIO_SR = media.AUDIO_SR


def _decode_video(vae, latent):
    """Core's VAEDecode verbatim — it unbinds the packed AV latent to the video stream
    first (`latent.unbind()[0]`), which vae.decode() cannot do on its own."""
    import nodes as comfy_nodes
    images = comfy_nodes.VAEDecode().decode(vae, latent)[0]
    return images.to(torch.float32).cpu()


def _decode_audio(audio_vae, latent):
    out = audio_nodes().VAEDecodeAudio.execute(vae=audio_vae, samples=latent)
    args = getattr(out, "args", None) or getattr(out, "result", None) or (out,)
    return args[0]


def _audio_to_stereo(audio):
    if audio is None:
        return None, AUDIO_SR
    waveform = audio.get("waveform")
    if waveform is None:
        return None, AUDIO_SR
    if waveform.ndim == 3:
        waveform = waveform[0]
    waveform = waveform.to(torch.float32).cpu()
    if waveform.shape[0] == 1:
        waveform = waveform.repeat(2, 1)
    elif waveform.shape[0] > 2:
        waveform = waveform[:2]
    return waveform, int(audio.get("sample_rate", AUDIO_SR))


def split_windows(duration_frames, window_frames):
    """Cut the render range into windows, folding a stub tail into the one before it."""
    window_frames = max(1, int(window_frames))
    windows = []
    cursor = 0
    while cursor < duration_frames:
        span = min(window_frames, duration_frames - cursor)
        windows.append((cursor, span))
        cursor += span
    # a sliver at the end is worse than one slightly longer window
    if len(windows) > 1 and windows[-1][1] < window_frames * 0.34:
        start, span = windows.pop()
        pstart, pspan = windows.pop()
        windows.append((pstart, pspan + span))
    return windows


class MiniMaxH3DirectorChain(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="MiniMaxH3DirectorChainCS",
            display_name="MiniMax H3 Director Chain",
            category="MiniMax H3",
            description=(
                "Renders a timeline longer than one H3 shot by chaining in-range windows, "
                "each opening on the previous window's last frame. Reads the same "
                "timeline_data as the Director and samples internally, so wire a SAMPLER "
                "and SIGMAS in rather than a KSampler after it."
            ),
            inputs=[
                # lazy, for the same reason as in the Director: without it ComfyUI reads
                # both ~21 GB checkpoints before the node runs, to use one of them.
                io.Model.Input("model", display_name="model (t2v/i2v)", optional=True, lazy=True,
                               tooltip="fl2va weights, used when the timeline's toolbar is on 'Refs OFF'."),
                io.Model.Input("model_ref2va", display_name="model (ref2v)", optional=True, lazy=True,
                               tooltip="ref2va weights, used when the toolbar is on 'Refs ON'. "
                                       "With only one model connected that one is used either way."),
                io.Clip.Input("clip"),
                io.Vae.Input("vae", tooltip="minimax_h3_video_vae."),
                io.Sampler.Input("sampler"),
                io.Sigmas.Input("sigmas"),
                io.String.Input("timeline_data", default="",
                                tooltip="Paste or wire the Director's timeline_data. Copy it from "
                                        "the Director node (right-click > Properties) or connect them."),
                io.Int.Input("noise_seed", default=0, min=0, max=0xffffffffffffffff,
                             control_after_generate=True,
                             tooltip="Base seed. Each window uses seed + its index."),
                io.Float.Input("window_seconds", default=5.0, min=1.0, max=15.0, step=0.5,
                               tooltip="Length of each window before anchoring the next one. "
                                       "5s (124 frames) is H3's sweet spot."),
                io.Int.Input("start_frame", default=0, min=0, max=100000, step=1),
                io.Int.Input("duration_frames", default=360, min=1, max=100000, step=1,
                             tooltip="Total length to render, in timeline frames."),
                io.Vae.Input("audio_vae", optional=True,
                             tooltip="minimax_h3_audio_vae. Without it the chain returns video only."),
                io.String.Input("global_prompt", multiline=True, default="", force_input=True,
                                optional=True),
                io.Float.Input("frame_rate", default=24, min=1, max=240, step=1, optional=True),
                io.Int.Input("custom_width", default=0, min=0, max=8192, step=1, optional=True),
                io.Int.Input("custom_height", default=0, min=0, max=8192, step=1, optional=True),
                io.Combo.Input("resize_method",
                               options=["maintain aspect ratio", "stretch to fit", "pad", "pad green", "crop"],
                               default="crop", optional=True),
                io.Int.Input("divisible_by", default=32, min=1, max=256, step=1, optional=True),
                io.Boolean.Input("use_custom_motion", default=True, optional=True),
                io.Boolean.Input("use_custom_audio", default=False, optional=True),
                io.Boolean.Input("override_audio", default=False, optional=True),
                io.Combo.Input("ref_image_size", options=["match", "max"], default="match", optional=True),
                io.Float.Input("shift_video", default=12.0, min=0.01, max=100.0, step=0.01, optional=True),
                io.Float.Input("shift_audio", default=3.0, min=0.01, max=100.0, step=0.01, optional=True),
            ],
            outputs=[
                io.Image.Output(display_name="images", tooltip="All windows concatenated, 24 fps."),
                io.Audio.Output(display_name="audio"),
                io.Float.Output(display_name="fps"),
                io.Int.Output(display_name="length", tooltip="Total frames rendered."),
                io.String.Output(display_name="prompts",
                                 tooltip="The storyboard prompt of every window, in order."),
            ],
        )

    @classmethod
    def check_lazy_status(cls, timeline_data="", model=director._UNCONNECTED,
                          model_ref2va=director._UNCONNECTED, **kwargs):
        """Ask for one checkpoint, exactly as the Director does.

        Every window of a chained render uses the same toolbar mode, so a single decision
        up front covers the whole run. Delegated so the two can never drift apart.
        """
        return director.MiniMaxH3Director.check_lazy_status(
            timeline_data=timeline_data, model=model, model_ref2va=model_ref2va, **kwargs)

    @classmethod
    def execute(cls, clip, vae, sampler, sigmas, timeline_data, noise_seed,
                model=None, model_ref2va=None,
                window_seconds=5.0, start_frame=0, duration_frames=360, audio_vae=None,
                global_prompt="", frame_rate=24, custom_width=0, custom_height=0,
                resize_method="crop", divisible_by=32, use_custom_motion=True,
                use_custom_audio=False, override_audio=False, ref_image_size="match",
                shift_video=12.0, shift_audio=3.0) -> io.NodeOutput:

        mm = core()
        sm = samplers()
        tdata = plan.parse_timeline(timeline_data)
        fps = float(frame_rate) if frame_rate else 24.0

        window_frames = max(1, int(round(float(window_seconds) * fps)))
        windows = split_windows(max(1, int(duration_frames)), window_frames)
        log.info("[MiniMaxChain] %d window(s) of ~%.1fs over %.1fs total.",
                 len(windows), window_frames / fps, duration_frames / fps)

        # reference_mode is a property of the timeline, so it is the same for every window
        ref_mode_on = str(tdata.get("reference_mode", "OFF")).upper() != "OFF"
        chosen_model = director.pick_model(model, model_ref2va, ref_mode_on)
        patched_model = director._unpack(mm.MiniMaxH3SigmaShift.execute(
            model=chosen_model, shift_video=float(shift_video),
            shift_audio=float(shift_audio)))[0]

        all_images, all_audio, prompts = [], [], []
        prev_last = None
        width = height = None
        pbar = comfy.utils.ProgressBar(len(windows))

        for index, (offset, span) in enumerate(windows):
            comfy.model_management.throw_exception_if_processing_interrupted()
            win_start = int(start_frame) + offset

            p = plan.plan_timeline(tdata, win_start, span, fps,
                                   global_prompt=global_prompt,
                                   use_custom_motion=use_custom_motion,
                                   use_custom_audio=use_custom_audio,
                                   override_audio=override_audio)
            for ev in p["events"]:
                ev["tensor"] = director._load_event_tensor(ev, fps, win_start)

            first_src = last_src = None
            for ev in p["events"]:
                if ev["role"] == plan.ROLE_FIRST:
                    first_src = ev["tensor"][:1]
                elif ev["role"] == plan.ROLE_LAST:
                    last_src = ev["tensor"][-1:]

            if width is None:
                canvas_src = first_src if first_src is not None else (
                    p["events"][0]["tensor"] if p["events"] else None)
                width, height = director.resolve_canvas(
                    mm, int(custom_width), int(custom_height), int(divisible_by),
                    resize_method, canvas_src)

            def fit(t):
                out = media.resize_image(t, width, height, resize_method, int(divisible_by))
                if out.shape[1] != height or out.shape[2] != width:
                    out = media.resize_image(out, width, height, "crop", int(divisible_by))
                return out

            # continuity: every window after the first opens on the previous last frame,
            # which outranks whatever the timeline put there
            if prev_last is not None:
                first_frame = prev_last
            else:
                first_frame = fit(first_src) if first_src is not None else None
            last_frame = fit(last_src) if last_src is not None else None

            prompts.append("[window %d | %s-%s] %s" % (
                index + 1, plan.fmt_seconds(offset / fps),
                plan.fmt_seconds((offset + span) / fps), p["prompt"]))

            if p["ref_mode_on"]:
                # the Director's loader, not a second copy of it — this node has no
                # ref_images socket of its own, so those slots are never planned here
                ref_imgs = director.load_ref_image_tensors(p["ref_image_slots"], fit)
                if first_frame is not None and len(ref_imgs) < plan.MAX_REF_IMAGES:
                    ref_imgs.append(first_frame)
                out = mm.MiniMaxH3ReferenceToVideo.execute(
                    clip=clip, vae=vae, audio_vae=audio_vae, prompt=p["prompt"],
                    width=width, height=height, length=p["length"],
                    ref_image_size=ref_image_size,
                    ref_images={"ref_image_%d" % i: t for i, t in enumerate(ref_imgs)} or None)
            else:
                out = mm.MiniMaxH3ImageToVideo.execute(
                    clip=clip, vae=vae, prompt=p["prompt"], width=width, height=height,
                    length=p["length"], first_frame=first_frame, last_frame=last_frame)

            conditioning, latent = director._unpack(out)[:2]

            guider = director._unpack(sm.BasicGuider.execute(
                model=patched_model, conditioning=conditioning))[0]
            noise = sm.Noise_RandomNoise(int(noise_seed) + index)
            sampled = director._unpack(sm.SamplerCustomAdvanced.execute(
                noise=noise, guider=guider, sampler=sampler, sigmas=sigmas,
                latent_image=latent))[0]

            images = _decode_video(vae, sampled)
            audio_chunk = None
            if audio_vae is not None:
                audio_chunk, sr = _audio_to_stereo(_decode_audio(audio_vae, sampled))
                if audio_chunk is not None and sr != AUDIO_SR:
                    try:
                        import torchaudio
                        audio_chunk = torchaudio.functional.resample(audio_chunk, sr, AUDIO_SR)
                    except Exception:
                        pass

            # the opening frame of a chained window IS the previous window's last frame —
            # keeping both would stutter on every seam
            drop = 1 if index > 0 else 0
            if drop and images.shape[0] > 1:
                images = images[drop:]
                if audio_chunk is not None:
                    cut = int(round(drop / MODEL_FPS * AUDIO_SR))
                    audio_chunk = audio_chunk[:, cut:]

            all_images.append(images)
            if audio_chunk is not None:
                all_audio.append(audio_chunk)
            prev_last = images[-1:].clone()

            log.info("[MiniMaxChain] window %d/%d done: %d frames (%s)",
                     index + 1, len(windows), images.shape[0], p["mode"])
            pbar.update(1)

        out_images = torch.cat(all_images, dim=0)
        if all_audio:
            out_audio = torch.cat(all_audio, dim=1)
        else:
            out_audio = torch.zeros(
                (2, max(1, int(round(out_images.shape[0] / MODEL_FPS * AUDIO_SR)))),
                dtype=torch.float32)

        log.info("[MiniMaxChain] finished: %d frames (%.2fs) at %dx%d",
                 out_images.shape[0], out_images.shape[0] / MODEL_FPS, width, height)

        return io.NodeOutput(out_images,
                             {"waveform": out_audio.unsqueeze(0), "sample_rate": AUDIO_SR},
                             MODEL_FPS, int(out_images.shape[0]), "\n\n".join(prompts))


NODE_CLASS_MAPPINGS = {"MiniMaxH3DirectorChainCS": MiniMaxH3DirectorChain}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxH3DirectorChainCS": "MiniMax H3 Director Chain"}
