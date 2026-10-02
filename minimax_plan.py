"""Timeline -> MiniMax H3 plan, with no pixels touched.

Everything that decides *what* a timeline means — which image is the opening frame,
which becomes a <Picture i> reference, what the storyboard prompt reads like — lives
here and works on metadata alone. Three callers share it:

* the Director node, which then loads exactly the media the plan calls for,
* the /minimax_director/compile_prompt endpoint behind the editor's live prompt
  preview, which loads nothing at all,
* the chain node, which plans one window per shot.

Keeping it in one place is the point: a prompt preview that disagrees with what is
actually sent would be worse than no preview.
"""

import json
import logging
import re

log = logging.getLogger(__name__)

MODEL_FPS = 24.0

# Limits straight from MiniMax's own model card (huggingface.co/MiniMaxAI/MiniMax-H3),
# not from ComfyUI's node signatures — the two do not agree everywhere.
MAX_REF_IMAGES = 9          # "<= 9 images"
MAX_REF_VIDEOS = 3          # "<= 3 clips"
MAX_REF_AUDIOS = 3          # "<= 3 clips"
MAX_REF_FILES = 12          # "at most 12 files in total across all input types"
REF_VIDEO_MIN_SEC = 2.0     # "each clip must be 2-15 seconds long"
REF_VIDEO_MAX_SEC = 15.0
REF_VIDEO_TOTAL_SEC = 15.0  # "total duration <= 15 seconds"
REF_AUDIO_MIN_SEC = 2.0     # audio clips: "2-15 seconds", "total <= 15 seconds"
REF_AUDIO_MAX_SEC = 15.0
# Decode bound for a reference video. Its frames are VAE-encoded whole and the resulting
# latents ride through every sampling step, so this is the biggest lever on memory there
# is — memory goes with the square of the short edge. 768 x 1344 is the native canvas;
# the ratio is kept so a lowered cap scales the area with it instead of squaring it away.
REF_VIDEO_SHORT_EDGE = 768
REF_VIDEO_ASPECT_BUDGET = 1344 / 768.0
REF_VIDEO_SIZES = (768, 640, 512, 384, 256)
# Output envelope: "4-15 seconds" at 24 fps
TRAINED_MIN_FRAMES = 96
TRAINED_MAX_FRAMES = 360

ROLE_FIRST = "first"
ROLE_LAST = "last"
ROLE_MIDDLE = "middle"

# A guide clip is VAE-encoded at the full canvas and its latent is re-injected at every
# sampling step, the same bill a reference video pays — and every row it adds is a row the
# DiT's full self-attention pays for quadratically. 39 frames is 1.6s at H3's own rate:
# long enough to carry a movement, short enough that a clip does not cost more than the
# window it sits in.
MAX_ANCHOR_CLIP_FRAMES = 39

# --- the full-reference vocabulary (references/ref-en.txt) ---------------------------
# The retention markers are "fixed English values in the output format", so they are
# emitted verbatim and never paraphrased. Whatever the editor sends is clamped back to a
# default rather than allowed to reach the prompt as an invented word.
RETENTION_VISIBLE = ("fully_preserved", "partially_preserved",
                     "attribute_transfer", "weak_reference")
RETENTION_AUDIO = ("fully_copy", "partially_copy", "reference", "weak_reference")
# fully_preserved is the right default even for a motion reference: the marker preserves
# the *defined role* of the content, and a reference video's defined role is its camera
# work, not its pixels. Audio defaults to `reference` because nothing here copies a
# signal — the track guides timbre and delivery.
RETENTION_DEFAULT = "fully_preserved"
RETENTION_AUDIO_DEFAULT = "reference"
# Not one of the guide's markers: a clip set to "lock" never becomes an <Audio N> at all. Its
# waveform is encoded straight into the target audio stream and held there, so the model
# makes the video around sound it cannot change. It lives in the same per-clip field only
# because that is where the editor already keeps "how is this clip used".
AUDIO_LOCK = "lock"

# <Subject N> is not a character slot. The guide lists "people, animals, or objects;
# scenes, backgrounds, or environments; clothing, props, interfaces, or visual effects;
# styles, actions, expressions, or poses". The noun is only used when a slot has no
# description of its own to put there.
SUBJECT_KINDS = {
    "person": "the person",
    "animal": "the animal",
    "object": "the object",
    "environment": "the environment",
    "clothing": "the outfit",
    "prop": "the prop",
    "interface": "the interface",
    "effect": "the visual effect",
    "style": "the visual style",
    "action": "the action",
    "expression": "the expression",
    "pose": "the pose",
}
SUBJECT_KIND_DEFAULT = "person"

# What "retained" means per kind, so a fully_preserved line says something the model can
# act on instead of repeating the marker back at it. `picture` and `video` are not subject
# kinds; they share the table because they need the same sentence.
RETAINED_DETAIL = {
    "person": "identity, face and clothing",
    "animal": "markings, coat and build",
    "object": "shape, colour and markings",
    "environment": "layout, furnishing and lighting",
    "clothing": "cut, colour and material",
    "prop": "shape, colour and wear",
    "interface": "layout, typography and iconography",
    "effect": "shape, colour and behaviour",
    "style": "palette, texture and grade",
    "action": "timing and body mechanics",
    "expression": "expression and gaze",
    "pose": "posture and limb placement",
    "picture": "framing and composition",
    "storyboard": "viewpoint, subject placement and shot order",
    "video": "camera work and motion",
}

# How a timeline image is used. `auto` keeps the behaviour the timeline already implies —
# classify_events decides whether it opens, closes or anchors a shot. The other two cover
# the guide's remaining cases: a shot-planning image, and an image that only *defines*
# something and therefore earns no standalone <Picture N> entry at all.
REF_ROLE_AUTO = "auto"
# The frame notation the reference guide gives for an image that "serves as a shot's first
# frame, keyframe, last frame, edited keyframe, or composition anchor". It is what "frame
# anchor" meant before H3 could take a guide at an arbitrary frame: the image is described
# to the model as a frame rather than sent as one.
REF_ROLE_PICTURE = "picture"
REF_ROLE_STORYBOARD = "storyboard"
REF_ROLE_SUBJECT = "subject"
REF_ROLES = (REF_ROLE_PICTURE, REF_ROLE_AUTO, REF_ROLE_STORYBOARD, REF_ROLE_SUBJECT)

# The reference tracks answer a narrower question than an image does — a clip is either an
# input the model is shown or a piece of the video it is asked to produce — so they share
# the image vocabulary's anchor value and have one of their own for the other answer.
REF_ROLE_REFERENCE = "reference"
CLIP_ROLES = (REF_ROLE_REFERENCE, REF_ROLE_AUTO)

MAX_SUBJECT_SLOTS = 9

TASK_KEYFRAME = "keyframe completion"
TASK_REFERENCE = "reference generation"
TASK_EDITING = "video editing"
TASK_CONTINUATION = "video continuation"
TASK_AUDIO_REUSE = "audio reuse"
TASK_AUDIO_REFERENCE = "audio reference"
# the guide's own table order, so a combined prefix always reads the same way round
TASK_ORDER = (TASK_KEYFRAME, TASK_REFERENCE, TASK_EDITING, TASK_CONTINUATION,
              TASK_AUDIO_REUSE, TASK_AUDIO_REFERENCE)


def align_frame_count(n):
    """H3 only accepts frame counts on the 17k+5 grid."""
    while n % 17 != 5:
        n += 1
    return n


def fmt_seconds(value):
    """0.0 -> '0s', 1.5 -> '1.5s' — the notation used in MiniMax's own templates."""
    rounded = round(float(value), 1)
    if abs(rounded - round(rounded)) < 1e-9:
        return "%ds" % int(round(rounded))
    return "%.1fs" % rounded


CHAR_TAG_RE = re.compile(r"@(?:character|char|ref)(\d+)")


def substitute_char_tags(text, replacements, later=None, seen=None):
    """Swap @ref1/@character1/@char1 .. @ref9 for their resolved text.

    A slot is no longer necessarily a character, so @refN is the name that fits what the
    slots now hold. @characterN/@charN keep working for every slot — prompts written
    against the old three-slot panel must not break.

    The whole number is read at once, so a slot number that does not exist is left alone
    rather than half-substituted: @ref11 used to come out as the slot-1 value with a
    stray "1" welded to it.

    `later` is the base guide's rule for a subject that has no <Subject N> label to lean
    on. There the identity lives in the prose, so it is written out in full where the
    subject first appears and named by a short handle afterwards — otherwise "a woman in
    a red coat" walks into every shot as a different woman. Tags resolve left to right
    and `seen` carries that across the global block and each shot in turn, so "first"
    means first in the finished video rather than first in whichever string this is.
    """
    if not text:
        return text or ""
    if seen is None:
        seen = set()

    def swap(match):
        slot = int(match.group(1))
        value = replacements.get(slot)
        if not value:
            return match.group(0)
        if later and slot in seen:
            value = later.get(slot) or value
        seen.add(slot)
        return value

    return CHAR_TAG_RE.sub(swap, text)


def sanitize_retention(value, audio=False):
    """Clamp a retention marker to the guide's fixed vocabulary."""
    allowed = RETENTION_AUDIO if audio else RETENTION_VISIBLE
    text = str(value or "").strip().lower()
    if text in allowed:
        return text
    return RETENTION_AUDIO_DEFAULT if audio else RETENTION_DEFAULT


def is_audio_lock(seg):
    return str((seg or {}).get("retention") or "").strip().lower() == AUDIO_LOCK


def sanitize_kind(value):
    text = str(value or "").strip().lower()
    return text if text in SUBJECT_KINDS else SUBJECT_KIND_DEFAULT


def sanitize_ref_role(value):
    """What an image is for. Unset means the frame notation, which is what it used to mean.

    Anchoring is the newer answer and the better one, but it is not the one a timeline
    written before it existed was asking for: every such image would silently stop being a
    <Picture N> and the whole prompt would change under a workflow nobody edited. So it is
    something you say, and saying nothing keeps what you had.
    """
    text = str(value or "").strip().lower()
    return text if text in REF_ROLES else REF_ROLE_PICTURE


def sanitize_clip_role(value):
    """A reference-track clip's role. Unset means reference — the tracks' whole purpose."""
    text = str(value or "").strip().lower()
    return text if text in CLIP_ROLES else REF_ROLE_REFERENCE


def overlaps(seg, win_start, win_end):
    start = float(seg.get("start", 0))
    length = float(seg.get("length", 1))
    return start < win_end and start + length > win_start


def seg_name(seg):
    """What to call a clip in a warning — the display name, or the file it came from."""
    seg = seg or {}
    return (seg.get("fileName") or seg.get("videoFile") or seg.get("audioFile")
            or "an unnamed clip")


def parse_timeline(timeline_data):
    try:
        return json.loads(timeline_data) if timeline_data else {}
    except Exception as e:
        log.error("[MiniMaxDirector] timeline_data parse error: %s", e)
        return {}


def ref_mode_from(tdata):
    """Is the toolbar on 'Refs ON (ref2va)'?

    Lives here rather than inline in the planner because the Director's lazy-input check
    has to answer the same question *before* the plan is built — the two must not drift,
    or the node would load one checkpoint and condition for the other.
    """
    return str(tdata.get("reference_mode", "OFF")).upper() != "OFF"


def retake_state(tdata):
    """The retake panel's state, or None when retake mode is off / has no base video."""
    if not tdata.get("retakeMode"):
        return None
    video = tdata.get("retakeVideo") or {}
    if not isinstance(video, dict):
        return None
    name = video.get("imageFile") or video.get("fileName")
    if not name:
        return None
    return {
        "video": name,
        "start": int(float(tdata.get("retakeStart", 0) or 0)),
        "length": max(1, int(float(tdata.get("retakeLength", 0) or 1))),
        "base_frames": int(float(video.get("videoDurationFrames", 0) or 0)),
        "prompt": tdata.get("retakePrompt", "") or "",
    }


FORMAT_MINIMAX = "minimax"
FORMAT_COMFYUI = "comfyui"


def fmt_timestamp(seconds):
    """MM:SS.mmm — the cut-time format MiniMax's prompt guide uses."""
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return "%02d:%06.3f" % (minutes, rest)


def retention_note(label, marker, kind=None, audio=False):
    """The `- …` half of a retention line, for when nothing was written by hand.

    The marker alone is the guide's fixed vocabulary; this is the sentence that says what
    the marker means *for this particular reference*, so the line carries something the
    model can act on instead of repeating the marker back at it.
    """
    if audio:
        return {
            "fully_copy": "%s is reused as the target video's complete final audio track.",
            "partially_copy": "part of %s is copied; other sounds are added, removed or "
                              "replaced.",
            "reference": "the target follows %s without copying the original signal.",
            "weak_reference": "only a broad similarity to %s in category and atmosphere "
                              "is kept.",
        }[marker] % label
    if marker == "fully_preserved":
        detail = RETAINED_DETAIL.get(kind or "")
        if detail:
            return "the %s of %s are retained." % (detail, label)
        return "%s is retained as defined." % label
    return {
        "partially_preserved": "%s is still used, with some of its defined characteristics "
                               "changed.",
        "attribute_transfer": "the characteristics of %s are transferred to a different "
                              "target subject.",
        "weak_reference": "only a broad similarity to %s in style, category, composition "
                          "and atmosphere is kept.",
    }[marker] % label


def picture_texts(ordinal, picture_role, ref_role, shot_no, at):
    """Every wording a standalone <Picture N> needs, derived once from the job it does.

    Four renderings, because the guide asks for the same fact in four places: the
    subject_definitions declaration (2.2), the retention_analysis parenthetical (4.1), the
    in-body phrasing (5.3), and — outside the guide entirely — the flat `Reference notes:`
    line the comfyui format keeps instead of all of the above.

    Deriving them together is the point: they described the same image in three different
    voices when the wording lived in three places, which is how issue #4 happened.
    """
    label = "<Picture %d>" % ordinal
    shot = "[Shot %d]" % shot_no if shot_no else ""

    if ref_role == REF_ROLE_STORYBOARD:
        target = shot or "the target video"
        return {
            "declaration": "%s is a storyboard reference for %s, defining its viewpoint, "
                           "subject placement, and shot order." % (label, target),
            "where": "storyboard reference for %s" % target,
            "phrase": "The shot follows the storyboard reference %s." % label if shot else "",
            "note": "%s is a storyboard reference for %s" % (label, target),
        }
    if picture_role == ROLE_FIRST:
        return {
            "declaration": "%s is the first frame of %s." % (label, shot or "the target video"),
            "where": ("%s first frame" % shot) if shot else "first frame",
            "phrase": ("The shot begins from %s." % label) if shot else "",
            "note": ("%s begins from %s" % (shot, label)) if shot
                    else "The video begins from %s" % label,
        }
    if picture_role == ROLE_LAST:
        return {
            "declaration": "%s is the last frame of %s." % (label, shot or "the target video"),
            "where": ("%s last frame" % shot) if shot else "last frame",
            "phrase": ("The shot ends on %s." % label) if shot else "",
            "note": ("%s ends on %s" % (shot, label)) if shot
                    else "The video ends on %s" % label,
        }
    # The guide's fourth phrasing, "the shot's keyframe corresponds to <Picture 2>", has no
    # image left to describe: one segment is one shot, so an image with a shot to belong to
    # is the image that opens it, and one without a shot has no keyframe to be. It is left
    # out rather than kept unreachable — a wording nothing can emit reads like a case the
    # planner handles.
    return {
        "declaration": "%s is a composition anchor at %s." % (label, at),
        "where": "composition anchor at %s" % at,
        "phrase": "",
        "note": "%s is a composition anchor at %s" % (label, at),
    }


def _subject_sentence(label, description, kind, pictures):
    """`<Subject 1> is a woman in a red coat, shown in <Picture 1>.`

    The guide's own shape is "<Subject 1> is the young woman in <Picture 1>, with long
    dark hair…" — description first, source second. A written description replaces the
    kind noun entirely, which is what makes the kind dropdown a fallback rather than a
    constraint.
    """
    text = (description or "").strip().rstrip(".")
    if text:
        return "%s is %s, shown in %s." % (label, text, pictures)
    return "%s is %s shown in %s." % (label, SUBJECT_KINDS[kind], pictures)


def _declaration(label, written, generated):
    """`<Label> is <what the user wrote>.`, or the generated sentence when nothing was.

    The label is prepended rather than expected in the text, so what gets typed is the
    predicate — "the voice-timbre reference for <Subject 1> (S1)" — and the label can
    never end up wrong or duplicated. A sentence that already opens with its own label is
    taken as written, since that is what someone pasting the guide's example will do.
    """
    text = (written or "").strip()
    if not text:
        return generated
    if text.startswith(label):
        return text if text.endswith((".", "!", "?")) else text + "."
    return "%s is %s." % (label, text.rstrip("."))


def _clean_voice(raw):
    """The voice clip a subject slot carries, or None. Only a file name is kept: the audio
    itself lives in ComfyUI's input folder like every other timeline audio."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("audioFile") or "").strip()
    if not name:
        return None
    return {"audioFile": name, "fileName": str(raw.get("fileName") or "").strip() or name}


def _voice_segs(subject_slots, fps):
    """One reference-audio segment per subject slot that carries a voice clip.

    These are timeline-free on purpose (issue #10): a voice reference is not part of the
    soundtrack and takes no output time, so it needs no place on the timeline and is not
    bounded by the render window. It is shaped like a parked timeline clip, bound to its
    slot, so everything downstream — labels, the "voice of <Subject N>" declaration, the
    speaker IDs, loading — treats it exactly like one.
    """
    segs = []
    for slot_no, slot in enumerate(subject_slots, 1):
        voice = slot.get("voice")
        if not voice:
            continue
        segs.append({"audioFile": voice["audioFile"], "fileName": voice["fileName"],
                     "trimStart": 0, "start": 0,
                     # the whole file, up to the 15 s the model takes per clip
                     "length": int(REF_AUDIO_MAX_SEC * fps),
                     "retention": RETENTION_AUDIO_DEFAULT,
                     "subject": slot_no, "voice_slot": slot_no})
    return segs


def _audio_subject_slot(seg):
    """Which subject slot an audio clip belongs to, 1-based, or None.

    Stored on the segment by the editor. Accepts the string a <select> hands over.
    """
    raw = (seg or {}).get("subject")
    if raw in (None, "", "none"):
        return None
    try:
        slot = int(raw)
    except (TypeError, ValueError):
        return None
    return slot if slot > 0 else None


def build_subject_definitions(subject_slots, ref_image_slots, ref_video_segs,
                              ref_audio_segs):
    """Declare every reference label, and record what each needs in retention_analysis.

    The guide's central rule about images lives here: an image only earns a standalone
    <Picture N> entry when it *is* a frame — "a shot's first frame, keyframe, last frame,
    edited keyframe, or composition anchor" — or a storyboard reference. An image that
    merely defines a character, scene, costume or style is cited inside the corresponding
    <Subject N> definition instead. ComfyUI's tokenizer still labels every image
    <Picture i>, so this is about which labels get *declared*, not which exist.

    Returns (lines, subject_of_slot, labels, pic_texts, subject_notes). `labels` is the
    ledger build_retention_analysis walks; `pic_texts` is keyed by <Picture N> ordinal;
    `subject_notes` is the same subject declarations in the flat phrasing the comfyui
    format needs, which is the only place that format can carry them at all (issue #14).
    """
    lines = []
    labels = []
    subject_of_slot = {}
    pic_texts = {}
    subject_notes = []
    subject_no = 0

    # --- <Subject N>: the panel slots first, so a subject's number does not move when
    # something is dropped on the timeline
    for slot_index, slot in enumerate(subject_slots):
        ordinals = [i + 1 for i, s in enumerate(ref_image_slots)
                    if s.get("source") == "char" and s.get("slot") == slot_index]
        if not ordinals:
            continue
        subject_no += 1
        subject_of_slot[slot_index + 1] = subject_no
        label = "<Subject %d>" % subject_no
        sentence = _subject_sentence(
            label, slot.get("description"), slot["kind"],
            " and ".join("<Picture %d>" % o for o in ordinals))
        lines.append(sentence)
        subject_notes.append(sentence.rstrip("."))
        labels.append({"label": label, "marker": slot["retention"], "kind": slot["kind"],
                       "note": slot.get("note", ""), "where": "", "audio": False,
                       "subject": subject_no})

    # ...then any timeline image the user marked as defining something rather than
    # anchoring a frame. It gets a subject of its own and no picture entry.
    for i, s in enumerate(ref_image_slots):
        if s.get("source") != "timeline" or s.get("ref_role") != REF_ROLE_SUBJECT:
            continue
        subject_no += 1
        label = "<Subject %d>" % subject_no
        s["subject"] = subject_no
        # `desc` says what the image defines, `note` says what survives into the target —
        # two different sentences in two different sections, so they are two fields. One
        # field would mean a subject-defining image could carry one or the other and never
        # both, and would have to mean something else again on a frame anchor.
        sentence = _subject_sentence(label, s.get("desc"), s["kind"],
                                     "<Picture %d>" % (i + 1))
        lines.append(sentence)
        subject_notes.append(sentence.rstrip("."))
        labels.append({"label": label, "marker": s["retention"], "kind": s["kind"],
                       "note": s.get("note", ""), "where": "", "audio": False,
                       "subject": subject_no})

    # --- <Picture N>: the real frame and storyboard anchors, plus any image on the
    # ref_images socket whose `ref_image_notes` line says what it is.
    # Character-slot images are deliberately absent — they are cited above instead. An
    # undescribed socket image stays absent too: the node knows nothing about it beyond the
    # pixels, and a vacuous "is an additional reference image" line would cost the model
    # attention without telling it anything.
    for i, s in enumerate(ref_image_slots):
        ordinal = i + 1
        if s.get("source") == "input":
            desc = (s.get("desc") or "").strip()
            if not desc:
                continue
            label = "<Picture %d>" % ordinal
            sentence = _declaration(label, desc, "")
            pic_texts[ordinal] = {"declaration": sentence, "where": "", "phrase": "",
                                  "note": sentence.rstrip(".")}
            lines.append(sentence)
            labels.append({"label": label, "marker": RETENTION_DEFAULT, "kind": "picture",
                           "note": "", "where": "", "audio": False})
            continue
        if s.get("source") != "timeline" or s.get("ref_role") == REF_ROLE_SUBJECT:
            continue
        texts = picture_texts(ordinal, s.get("picture_role"), s.get("ref_role"),
                              s.get("shot_no"), s.get("at"))
        pic_texts[ordinal] = texts
        lines.append(texts["declaration"])
        labels.append({"label": "<Picture %d>" % ordinal, "marker": s["retention"],
                       "kind": "storyboard" if s.get("ref_role") == REF_ROLE_STORYBOARD
                               else "picture",
                       "note": s.get("note", ""),
                       "where": texts["where"], "audio": False})

    # A <Video N> or <Audio N> declaration is pure prose — unlike a <Picture N>, it states
    # no structural fact the planner already knows — so a written one simply replaces it.
    # That is the only way to reach the guide's own shapes, which name things this node
    # cannot infer: "<Audio 1> is the voice-timbre reference for <Subject 1> (S1)", or
    # "<Video 1> is the source video for the target video edit".
    for i, seg in enumerate(ref_video_segs):
        label = "<Video %d>" % (i + 1)
        lines.append(_declaration(
            label, seg.get("refDesc"),
            "%s is a reference video: follow its motion and camera work." % label))
        labels.append({"label": label, "kind": "video", "audio": False,
                       "marker": sanitize_retention(seg.get("retention")),
                       "note": (seg.get("refNote") or "").strip(),
                       "where": "motion and camera work"})
    for i, seg in enumerate(ref_audio_segs):
        label = "<Audio %d>" % (i + 1)
        marker = sanitize_retention(seg.get("retention"), audio=True)
        copied = marker in ("fully_copy", "partially_copy")
        # A clip can name the subject whose voice it carries, which is the one thing a
        # written sentence should not have to spell out: with two voice references and no
        # binding there is nothing in the prompt saying which voice belongs to whom
        # (issue #10). The guide ends that sentence with the speaker's global ID,
        # "<Subject 1> (S1)", which is not knowable here — IDs are assigned in vocal-event
        # order, further down. apply_speaker_ids fills it in afterwards, which is what
        # `line_index` is for.
        subject = subject_of_slot.get(_audio_subject_slot(seg))
        if subject:
            # the generated declaration has to agree with the marker: telling the model to
            # follow a clip's timbre while retention_analysis says the signal is copied
            # wholesale describes two different jobs
            generated = ("%s carries the voice of <Subject %d>: its signal is reused in the "
                         "target video." % (label, subject) if copied else
                         "%s is the voice-timbre reference for <Subject %d>."
                         % (label, subject))
        else:
            generated = ("%s is a reference audio clip: %s"
                         % (label, "its signal is reused in the target video." if copied
                            else "follow its voice and timbre."))
        lines.append(_declaration(label, seg.get("refDesc"), generated))
        # `voice_of` rather than `subject`: build_retention_analysis reads that key as "this
        # entry *is* a subject" and would replace the audio line's "(voice of <Subject 2>)"
        # with a shot list belonging to somebody else.
        labels.append({"label": label, "kind": "audio", "audio": True, "marker": marker,
                       "note": (seg.get("refNote") or "").strip(),
                       "voice_of": subject, "line_index": len(lines) - 1,
                       "where": "voice of <Subject %d>" % subject if subject else ""})

    return lines, subject_of_slot, labels, pic_texts, subject_notes


def build_retention_analysis(labels, subject_shots=None):
    """One line per reference label, in the guide's `label (where): marker - note` shape.

    A subject's parenthetical names the shots it actually appears in, read back off the
    shot text after tag substitution rather than assumed — a subject defined in the panel
    but never mentioned in any shot simply has no shot list to give.
    """
    subject_shots = subject_shots or {}
    lines = []
    for entry in labels:
        where = entry.get("where") or ""
        if entry.get("subject"):
            shots = subject_shots.get(entry["subject"]) or []
            if shots:
                where = "appears in " + ", ".join("[Shot %d]" % n for n in shots)
        note = (entry.get("note") or "").strip()
        if note:
            if not note.endswith((".", "!", "?")):
                note += "."
        else:
            note = retention_note(entry["label"], entry["marker"], entry.get("kind"),
                                  entry.get("audio", False))
        head = "%s (%s)" % (entry["label"], where) if where else entry["label"]
        lines.append("%s: %s - %s" % (head, entry["marker"], note))
    return lines


def task_type_prefix(ref_image_slots, ref_video_segs, ref_audio_segs, override=None,
                     anchored=False):
    """The square-bracketed task type the guide puts at the head of `summary`.

    Derived from the jobs the references actually do, not from what happens to be
    connected: the guide is explicit that "the mere presence of video or audio does not
    automatically create a corresponding task type", and that a reference video supplying
    only camera movement, cuts or rhythm is reference generation, not video editing.

    `video editing` and `video continuation` are therefore never derived — this node has
    no path that edits or continues a source video. The override exists for the day one
    is added, and for anything else the timeline cannot know.
    """
    if (override or "").strip():
        return "[%s]" % override.strip().strip("[]").strip()

    types = set()
    # An anchored image is not in the slots at all — it is a frame of the video rather than
    # something the model is shown — but it is exactly what makes this keyframe completion,
    # so the job it does is read from the anchors instead of from the reference list.
    if anchored:
        types.add(TASK_KEYFRAME)
    for s in ref_image_slots:
        if s.get("source") == "timeline" and s.get("ref_role") == REF_ROLE_PICTURE:
            types.add(TASK_KEYFRAME)
        else:
            types.add(TASK_REFERENCE)
    if ref_video_segs:
        types.add(TASK_REFERENCE)
    for seg in ref_audio_segs:
        types.add(TASK_AUDIO_REUSE
                  if sanitize_retention(seg.get("retention"), audio=True)
                  in ("fully_copy", "partially_copy")
                  else TASK_AUDIO_REFERENCE)

    ordered = [t for t in TASK_ORDER if t in types]
    return ("[%s]" % " + ".join(ordered)) if ordered else ""


def alignment_instruction(has_first, has_last, shot_count, seconds):
    """The image-alignment line the base guide requires as the very first line.

    Quoted verbatim from VIDEO_PROMPT_WRITING_GUIDE_base_en.md, including its own
    inconsistency: I2VA and L2VA bracket the tokens (`<Picture 1>`, `[Shot 1]`) while
    FL2VA does not. The model was trained on that text, so it is reproduced as written
    rather than tidied up.

    T2VA has no instruction, and the reference guide does not ask for one at all, so this
    only applies to the fl2va path.

    S.SS is the *effective* duration — after snapping to the 17k+5 grid, so a 5s request
    reports 5.16, not 5.00. It is floored to the hundredth rather than rounded, because
    rounding can name a mark that is past the end of the video: 124 frames last
    5.166667s, and "5.17" is outside the clip it is describing. Ten of the twenty-four
    valid frame counts up to 16s round that way (issue #6). The multiply-round-then-floor
    keeps binary noise from stealing a hundredth off an exact value like 12.25.
    """
    n = max(1, int(shot_count))
    s = "%.2f" % (int(round(max(0.0, float(seconds)) * 10000)) // 100 / 100.0)
    if has_first and has_last:
        return ("How the reference pictures align with the target video — Picture 1 "
                "(from Shot 1) aligns with the 0.00-second mark of the target video; "
                "Picture 2 (from Shot %d) aligns with the %s-second mark of the target "
                "video." % (n, s))
    if has_first:
        return ("For the target video, at 0.00 seconds into the target video, "
                "<Picture 1> (from [Shot 1]) is fully referenced.")
    if has_last:
        return ("How the reference pictures align with the target video — <Picture 1> "
                "(from [Shot %d]) aligns with the %s-second mark of the target video."
                % (n, s))
    return ""


def compile_storyboard_minimax(global_prompt, shots, soundscape="", music="",
                               subject_lines=None, retention_lines=None,
                               instruction="", summary=""):
    """The notation MiniMax documents in VIDEO_PROMPT_WRITING_GUIDE_*.md.

    `integrated_multimodal_description: [Shot 1] … [Shot 2] At 00:05.000, …`, with the
    first shot carrying no timestamp and every later cut carrying a strictly increasing
    one, followed by the soundscape fields. Sections are only emitted when there is
    something real to put in them — an empty heading is worse than none.

    Section order is the reference guide's: subject_definitions, summary,
    retention_analysis, detailed_description, then the two sound fields.

    subject_definitions and retention_analysis are written one entry per line, the way the
    guide's own example lays them out. Both are lists of records — one per reference label
    — rather than prose, and running them together into a paragraph makes it genuinely
    hard to see where one label's definition ends and the next begins. detailed_description
    stays a single flowing block, because that one really is prose.
    """
    parts = []

    # the guide: "must be the first line of the final prompt, followed by one blank line
    # before the core fields" — joining parts with a blank line gives exactly that
    if (instruction or "").strip():
        parts.append(instruction.strip())

    if subject_lines:
        parts.append("subject_definitions:\n" + "\n".join(subject_lines))
    if (summary or "").strip():
        parts.append("summary: " + summary.strip())
    if retention_lines:
        parts.append("retention_analysis:\n" + "\n".join(retention_lines))

    written = [s for s in shots if shot_has_text(s)]
    body = []
    gp = (global_prompt or "").strip()
    if gp:
        body.append(gp)
    for index, shot in enumerate(written):
        pieces = list(shot.get("pieces") or [])
        # guide 5.3: a frame anchor is named in the shot itself, in natural phrasing, as
        # well as being declared above. It rides with the prose rather than trailing the whole
        # shot — it says how the shot opens, and a spoken line is not something a shot "begins
        # from" — so it goes after the last prose piece, which for a shot that is all prose is
        # where it has always gone.
        phrases = " ".join(shot.get("ref_phrases") or [])
        if phrases:
            last_prose = max((i for i, (kind, _) in enumerate(pieces) if kind == "prose"),
                             default=-1)
            if last_prose < 0:
                # nothing of the user's own to attach to, and a later shot opens
                # "At 00:05.000, " — so our own sentence has to continue out of that comma
                pieces.insert(0, ("prose", phrases if not index
                                  else phrases[0].lower() + phrases[1:]))
            else:
                pieces.insert(last_prose + 1, ("prose", phrases))
        text = join_shot_pieces([piece for _, piece in pieces])
        if index == 0:
            body.append("[Shot 1] %s" % text)
        else:
            body.append("[Shot %d] At %s, %s"
                        % (index + 1, fmt_timestamp(shot["start_sec"]), text))
    if body:
        parts.append(("detailed_description: " if subject_lines
                      else "integrated_multimodal_description: ") + " ".join(body))

    if (soundscape or "").strip():
        parts.append("overall_soundscape: " + soundscape.strip())
    if (music or "").strip():
        parts.append("non_diegetic_music: " + music.strip())
    elif parts:
        # Both guides list non_diegetic_music as a required field, and both write "N/A"
        # in it — the base guide says to do so "when there is no non-diegetic music",
        # which is exactly what an empty box means. overall_soundscape deliberately does
        # not get the same treatment: there "N/A" is reserved for a video the user asked
        # to be silent, so filling it in would state something nobody said.
        #
        # `parts` guards against writing a prompt that is nothing but this line.
        parts.append("non_diegetic_music: N/A")

    return "\n\n".join(parts).strip()


SOUND_PREFIXES = ("audio:", "sound:", "soundscape:", "sfx:")
MUSIC_PREFIXES = ("music:", "score:", "soundtrack:")


def split_audio_music(text):
    """Lift `Audio: …` / `Music: …` lines out of a prompt into their own fields.

    Everyone writes the soundtrack into the prompt as an "Audio:" line — MiniMax's own
    ComfyUI templates do it too — while the guide wants it in overall_soundscape and
    non_diegetic_music. Only a line that *starts* with one of these labels counts, so
    prose that merely mentions sound is left where it is. Whatever follows such a line
    without its own label belongs to it.
    """
    if not text:
        return "", "", ""
    kept, sound, music = [], [], []
    current = None
    for line in text.splitlines():
        stripped = line.strip()
        low = stripped.lower()
        if any(low.startswith(p) for p in SOUND_PREFIXES):
            current = sound
            stripped = stripped.split(":", 1)[1].strip()
        elif any(low.startswith(p) for p in MUSIC_PREFIXES):
            current = music
            stripped = stripped.split(":", 1)[1].strip()
        elif not stripped:
            current = None            # a blank line ends the block
            kept.append(line)
            continue
        elif current is None:
            kept.append(line)
            continue
        if stripped:
            current.append(stripped)
    return "\n".join(kept).strip(), " ".join(sound).strip(), " ".join(music).strip()


# A dialogue line in a shot prompt. Same rule as split_audio_music: it only counts at the
# start of a line, so prose that merely contains an @ref tag or a colon is left alone.
#
#   @ref1 exclaims with light annoyance: Hey! Watch your dog!
#   @ref1 [French] murmure: Bonjour
#   @voice(a low male narrator) says: In the beginning...
#   @audio2: the chorus line carried by the track itself
#
# The clause between the tag and the colon is the delivery, kept verbatim — the guide's own
# example carries the performance there ("says in a casual young male voice with a playful
# tone"), and generating a flat "says" would throw that away.
DIALOGUE_RE = re.compile(
    r"^@(?:ref(?P<slot>\d+)|voice\((?P<voice>[^)]*)\)|audio(?P<audio>\d+))"
    r"\s*(?:\[(?P<lang>[^\]]+)\])?"
    r"\s*(?P<delivery>[^:]*):\s*(?P<line>.+)$", re.IGNORECASE)

DIALOGUE_DEFAULT_LANG = "English"
DIALOGUE_DEFAULT_DELIVERY = "says"

SPEAKER_ID_RE = re.compile(r"\(S\d+\)")

# "Generation tasks typically span 350-500 words", which the preview reports as a figure so
# the range is visible without being nagged about. The guide itself warns against
# "mechanical word-count adherence".
DESCRIPTION_MIN_WORDS = 350
DESCRIPTION_MAX_WORDS = 500


# Where a lifted dialogue line sat, left behind in the prose so render_shot can put the
# spoken line back exactly there. A shot is not a paragraph followed by its dialogue — the
# guide's own Shot 1 goes action, spoken line, more action — so a line written between two
# paragraphs has to stay between them. Invisible to the user: every mark is consumed during
# rendering, and any \x00 in the incoming text is dropped before one can be confused for it.
DIALOGUE_MARK = "\x00%d\x00"
DIALOGUE_MARK_RE = re.compile("\x00(\\d+)\x00")

# The guide runs an action straight out of a spoken line with no punctuation between them:
# "…<d>[English] Hey! Watch your dog!</d> She closes her lips…"
DIALOGUE_CLOSE = "</d>"


def split_dialogue(text):
    """Lift `@ref1 says: …` lines out of a shot prompt into structured vocal events.

    Returns (remaining prose, events). The prose keeps a DIALOGUE_MARK where each lifted line
    sat, so the shot can be reassembled in the order it was written.

    Speaker IDs are deliberately *not* assigned here: the guide numbers them "according to the
    order of actual vocal events in the target video", which is a property of the whole
    timeline, not of one shot.
    """
    if not text:
        return text or "", []
    kept, events = [], []
    for line in text.replace("\x00", "").splitlines():
        match = DIALOGUE_RE.match(line.strip())
        if not match:
            kept.append(line)
            continue
        kept.append(DIALOGUE_MARK % len(events))
        events.append({
            "slot": int(match.group("slot")) if match.group("slot") else None,
            "voice": (match.group("voice") or "").strip() or None,
            "audio": int(match.group("audio")) if match.group("audio") else None,
            "language": (match.group("lang") or DIALOGUE_DEFAULT_LANG).strip(),
            "delivery": (match.group("delivery") or "").strip() or DIALOGUE_DEFAULT_DELIVERY,
            "line": match.group("line").strip(),
        })
    return "\n".join(kept).strip(), events


# Two ways a line that was meant to be spoken reaches the model as narration instead:
#
#   @ref1 says "hello sir"     no colon, so DIALOGUE_RE never claimed it
#   @char1 says: hello sir     an alias substitute_char_tags resolves and DIALOGUE_RE does not
#
# Both are reported rather than repaired. The colon is the whole rule, and widening it to take
# quoted text would claim prose that quotes something nobody says out loud.
#
# The quoted words have to *end* the line, which is where dialogue puts them — the same place
# the colon form puts them. That is what separates the near-miss from ordinary prose that
# happens to quote a thing: `@ref1 reads the sign "Closed" and frowns` carries on afterwards
# and is left alone. A line that genuinely ends on a quoted noun — `@ref1 points at the sign
# "CLOSED"` — is still caught, which costs one sentence in the warnings strip and changes
# nothing about the prompt. A verb list would settle those, and would break on the first
# prompt written in another language.
NEAR_MISS_QUOTE_RE = re.compile(
    u"^@(?:ref|char|character)\\d+[^:\"“«]*[\"“«][^\"”»]+[\"”»][\\s.!?,;]*$",
    re.IGNORECASE)
NEAR_MISS_ALIAS_RE = re.compile(r"^@(?:char|character)(\d+)[^:]*:\s*\S", re.IGNORECASE)


def near_miss_dialogue(text):
    """Lines in a shot's prose that read as dialogue but did not become any.

    Returns (line, reason) pairs, `reason` being "colon" or "alias" — enough for the caller to
    say which rule was missed without this having to know about shot numbering or warnings.
    """
    found = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if NEAR_MISS_ALIAS_RE.match(stripped):
            found.append((stripped, "alias"))
        elif ":" not in stripped and NEAR_MISS_QUOTE_RE.match(stripped):
            found.append((stripped, "colon"))
    return found


def shot_has_text(shot):
    """Does this shot appear in the body, and therefore carry a [Shot N] number?

    A shot whose only content is dialogue still counts. Testing the prompt alone would
    drop it from the body once the dialogue was lifted out — losing the line and shifting
    every later shot number, including the ones picture notes point at.
    """
    return bool((shot.get("prompt") or "").strip() or shot.get("dialogue"))


def render_event(event, ids, label_for_slot):
    """One vocal event, numbering any speaker met here for the first time.

    `(Sx)` is assigned once per speaker, in the order vocal events actually occur, and reused
    at every later event by that speaker — so the same person keeps one ID across cuts, exactly
    as <Subject N> does. Verbal content carried by reused audio names <Audio N> as its source
    and gets no ID at all: the guide is explicit that a cue inside a soundtrack has no
    independent vocal source to number.
    """
    tag = "<d>[%s] %s</d>" % (event["language"], event["line"])
    if event["audio"]:
        return "<Audio %d> carries %s" % (event["audio"], tag)
    if event["slot"]:
        who = label_for_slot(event["slot"]) or "an unnamed speaker"
        key = ("slot", event["slot"])
    else:
        who = event["voice"] or "an unnamed speaker"
        key = ("voice", who.strip().lower())
    if key not in ids:
        ids[key] = len(ids) + 1
    return "%s (S%d) %s, %s" % (who, ids[key], event["delivery"], tag)


def join_shot_pieces(parts):
    """Run a shot's pieces together, supplying the full stop the next one needs.

    A piece ending on `</d>` is left alone — the guide continues straight out of a spoken line
    into the next action, with no punctuation between them.
    """
    out = ""
    for part in parts:
        part = (part or "").strip()
        if not part:
            continue
        if not out:
            out = part
            continue
        if not out.endswith((".", "!", "?", ",", ";", ":", DIALOGUE_CLOSE)):
            out += "."
        out += " " + part
    return out


def render_shot(shot, values, later=None, seen=None, ids=None, label_for_slot=None):
    """Resolve one shot's tags and spoken lines, in the order they were written.

    A single pass, because both orderings the guide cares about are properties of the finished
    shot read left to right: "the first appearance" of a subject, which decides whether it is
    named in full or by its short name, and "the order of actual vocal events", which decides
    `(Sx)`. Reading all the prose and then all the dialogue gets both wrong for a shot whose
    dialogue is not simply trailing — and moves the line, which is worse than either.

    Fills `shot["pieces"]`, ("prose"|"dialogue", text) in written order, and `shot["text"]`,
    the pieces run together. The pieces are kept so a frame anchor can be placed against the
    prose instead of after a spoken line.
    """
    events = shot.get("dialogue") or []
    pieces = []
    # re.split with one group alternates prose, mark, prose, mark, … so odd indices are marks
    for index, part in enumerate(DIALOGUE_MARK_RE.split(shot.get("prompt") or "")):
        if index % 2:
            slot = int(part)
            text = (render_event(events[slot], ids, label_for_slot)
                    if 0 <= slot < len(events) else "")
            kind = "dialogue"
        else:
            text = substitute_char_tags(part, values, later, seen).strip()
            kind = "prose"
        if text:
            pieces.append((kind, text))
    shot["pieces"] = pieces
    shot["text"] = join_shot_pieces([text for _, text in pieces])


def apply_speaker_ids(lines, labels, speaker_of_subject):
    """Fill each voice clip's declaration in with the speaker's global ID.

    The guide asks a bound `<Audio N>` to "reuse that speaker's global ID in the definition":
    `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).` The ID cannot be known
    when that sentence is written — speakers are numbered in the order vocal events occur,
    which is a property of the finished body, not of one declaration — so the line is patched
    here, once the numbering pass has run.

    A subject that never speaks has no ID and its declaration keeps the label alone, which is
    still an unambiguous binding. `(Sx)` deliberately does not reach retention_analysis: the
    guide reserves it for detailed_description, and only these declaration lines are touched.
    """
    for entry in labels:
        subject = entry.get("voice_of")
        index = entry.get("line_index")
        if not subject or index is None:
            continue
        speaker = speaker_of_subject.get(subject)
        if not speaker:
            continue
        line = lines[index]
        # a sentence that spells out its own ID is taken as written, the same way
        # _declaration takes a sentence that opens with its own label
        if SPEAKER_ID_RE.search(line):
            continue
        # A written sentence need not name the subject it was bound to, and an ID attached to
        # nothing reads as belonging to whoever is named instead. The closing ">" keeps
        # <Subject 1> from matching inside <Subject 10>.
        ref = "<Subject %d>" % subject
        if ref not in line:
            continue
        lines[index] = line.replace(ref, "%s (S%d)" % (ref, speaker), 1)


ANALYSIS_DESC_PREFIX = "description:"
ANALYSIS_KEEP_PREFIX = "retained:"


def split_analysis(text):
    """Split the Analyze button's two labelled lines into (description, retained).

    The vision model is asked for `DESCRIPTION:` and `RETAINED:`, which fill the slot's
    two boxes: what the subject *is*, and what has to survive into the target video.

    Local models ignore an output format often enough that the unlabelled case has to be
    the safe one — everything becomes the description, which is where a single blob of
    text was going before there was a second box. A label may also arrive lowercased, in
    bold, or with the model's own preamble above it, so matching is case-insensitive,
    tolerant of `*` and `#` decoration, and picks up wherever the first label appears.

    Lives here rather than in minimax_media so it can be tested without importing
    aiohttp or ComfyUI — the same reason split_audio_music is here.
    """
    if not text:
        return "", ""
    rows = []
    labelled = False
    for line in str(text).splitlines():
        stripped = line.strip().lstrip("*#-• ").strip()
        low = stripped.lower()
        if low.startswith(ANALYSIS_DESC_PREFIX):
            rows.append(("desc", stripped.split(":", 1)[1]))
            labelled = True
        elif low.startswith(ANALYSIS_KEEP_PREFIX):
            rows.append(("keep", stripped.split(":", 1)[1]))
            labelled = True
        else:
            rows.append((None, stripped))

    desc, keep, current = [], [], None
    for kind, value in rows:
        if kind:
            current = desc if kind == "desc" else keep
        elif current is None:
            # Before any label. With labels present this is the model's own preamble
            # ("Sure! Here is the analysis:") and belongs in neither box; with no labels
            # anywhere it is the whole answer, and the description is where a single blob
            # of text went before there was a second box.
            if labelled:
                continue
            current = desc
        value = value.strip().strip("*").strip()
        if value:
            current.append(value)
    return " ".join(desc).strip(), " ".join(keep).strip()


def compile_storyboard(global_prompt, shots, total_seconds):
    """Global block, then timed shot lines in the ComfyUI templates' `[0s-1.5s]` notation."""
    written = [s for s in shots if shot_has_text(s)]

    # Dialogue was lifted out of the prompt before this format ever saw it, so it has to be
    # put back or a spoken line would vanish from a comfyui-format prompt entirely. render_shot
    # has already done that, in the order it was written.
    def body(shot):
        return (shot.get("text") or "").strip()

    parts = []
    gp = (global_prompt or "").strip()
    if gp:
        parts.append(gp)

    if len(written) == 1 and written[0]["start_sec"] <= 0.01 and \
            written[0]["end_sec"] >= total_seconds - 0.01:
        # One shot covering the whole window is just a prompt — wrapping it in
        # storyboard syntax would imply a cut that isn't there.
        parts.append(body(written[0]))
    elif written:
        parts.append("Timeline:\n" + "\n".join(
            "[%s-%s] %s" % (fmt_seconds(s["start_sec"]), fmt_seconds(s["end_sec"]), body(s))
            for s in written))

    return "\n\n".join(parts).strip()


def classify_events(events, duration_frames, fps):
    """Assign each main-track image/video segment its keyframe role.

    The opening and the closing frame have a slot of their own in the core node, which is
    what this decides. Everything else is a middle — a reference on the ref2va path, and a
    guide anchored where it sits on the fl2va one (see anchor_events).
    """
    head_window_f = max(1.0, fps * 0.5)
    have_first = have_last = False
    for ev in events:
        starts_at_head = ev["rel_start_f"] <= head_window_f
        reaches_tail = ev["rel_end_f"] >= duration_frames - 0.5

        # An explicit "end frame" flag always wins. Otherwise an image that merely runs to
        # the end of the window is only a closing frame if it did not also start at the
        # head — one clip spanning the whole timeline is the classic i2v case and means
        # "start from this image".
        if ev["is_end"] or (reaches_tail and not starts_at_head):
            if not have_last or ev["is_end"]:
                ev["role"] = ROLE_LAST
                have_last = True
                continue
        if starts_at_head and not have_first:
            ev["role"] = ROLE_FIRST
            have_first = True
            continue
        ev["role"] = ROLE_MIDDLE
    return events


def anchor_clip_frames(available):
    """Longest guide clip that fits in `available` output frames.

    H3 anchors a clip only at its own lengths — 5, 22, 39, 17k+5 — and a batch shorter than
    five frames is taken as a single image, which is what 1 means here. Core crops a batch
    the same way; the length is worked out on this side as well so the Director can check
    the fit before it hands anything over, rather than finding out through a ValueError
    with the models already in VRAM.
    """
    n = min(int(available), MAX_ANCHOR_CLIP_FRAMES)
    if n < 5:
        return 1
    while n % 17 != 5:
        n -= 1
    return n


def anchor_events(events, length, fps, ends_reserved=True):
    """Give every anchored image the output frame it lands on. Returns what was skipped.

    The timeline runs at the editor's fps and the output at MODEL_FPS, over a length that
    has been snapped *up* onto the 17k+5 grid, so the position is a rescale and a clamp.
    Any integer index is legal — PackedLayout places a guide at a continuous position, not
    on a grid — so only the clip length has to land on H3's own lengths.

    `ends_reserved` is the difference between the two paths. On fl2va the opening and
    closing frames ride the core node's own keyframe slots, so they are left alone here and
    a second cond block on the same frame would only argue with them. ref2va has no such
    slots: there every frame anchor is anchored, the opening image at frame 0 and one
    flagged as an end frame at the last.

    An image that resolves onto a frame already spoken for is skipped either way, and
    named, because dropping it in silence is what this feature exists to stop.
    """
    taken = set()
    if ends_reserved:
        for ev in events:
            if ev["role"] == ROLE_FIRST:
                taken.add(0)
            elif ev["role"] == ROLE_LAST:
                taken.add(length - 1)

    skipped = []
    for ev in events:
        if ends_reserved and ev["role"] != ROLE_MIDDLE:
            continue
        if ev["role"] == ROLE_FIRST:
            idx = 0
        elif ev["role"] == ROLE_LAST:
            idx = length - 1
        else:
            idx = max(0, min(int(round(ev["rel_start_f"] / fps * MODEL_FPS)), length - 1))
        if idx in taken:
            skipped.append(ev)
            continue
        want = 1
        if ev["kind"] == "video":
            span = int(round((ev["rel_end_f"] - ev["rel_start_f"]) / fps * MODEL_FPS))
            want = anchor_clip_frames(min(span, length - idx))
        ev["anchor_frame"] = idx
        ev["anchor_clip_frames"] = want
        taken.add(idx)
    return skipped


def plan_timeline(tdata, win_start, duration_frames, fps, global_prompt="",
                  use_custom_motion=True, use_custom_audio=False, override_audio=False,
                  extra_ref_image_count=0, soundscape="", music="", prompt_format=None,
                  summary="", ref_image_notes="", prepend_text=""):
    """Work out shots, keyframe roles, reference ordinals and the final prompt.

    Returns a dict; `execute` uses it to decide what media to load, the endpoint just
    reads `prompt`.
    """
    win_end = win_start + duration_frames
    window_seconds = duration_frames / fps
    retake = retake_state(tdata)

    if not global_prompt:
        global_prompt = tdata.get(
            "retake_global_prompt" if retake else "global_prompt", "") or ""

    # Text wired into the node (LoRA trigger words from a loader, typically) goes in front
    # of the scene description. It is joined here rather than glued onto the finished
    # prompt: in the minimax format the prompt opens with the task line and the labelled
    # sections, which text in front of them would break.
    prepend_text = (prepend_text or "").strip().strip(",").strip()
    if prepend_text:
        global_prompt = ("%s, %s" % (prepend_text, global_prompt.strip())
                         if global_prompt.strip() else prepend_text)

    # The editor's two soundscape boxes live in the timeline, so both consumers read them
    # from the same place and no third copy can go stale. Unlike the global prompt these
    # have no retake twin on purpose: re-rolling part of a shot does not change what the
    # room sounds like. An explicit argument still wins, which is what lets a caller
    # override them without touching the timeline.
    if not (soundscape or "").strip():
        soundscape = tdata.get("overall_soundscape", "") or ""
    if not (music or "").strip():
        music = tdata.get("non_diegetic_music", "") or ""

    ref_mode_on = ref_mode_from(tdata)
    if prompt_format is None:
        prompt_format = str(tdata.get("prompt_format", FORMAT_MINIMAX)).lower()
    if prompt_format not in (FORMAT_MINIMAX, FORMAT_COMFYUI):
        prompt_format = FORMAT_MINIMAX

    # --- subject slots (metadata only) ---
    # `subjects` is what the editor writes now; `characters` is the same panel's old key
    # and is still read, because a slot holding a scene or a prop is the same structure
    # that used to hold only characters.
    subject_slots = []
    raw_slots = tdata.get("subjects")
    if not isinstance(raw_slots, list):
        raw_slots = tdata.get("characters", []) or []
    for info in raw_slots[:MAX_SUBJECT_SLOTS]:
        images_list = info.get("images", []) or []
        legacy_b64 = info.get("imageB64", "")
        if legacy_b64 and not images_list:
            images_list = [{"b64": legacy_b64, "name": info.get("fileName", "")}]
        subject_slots.append({
            "images": images_list,
            "description": info.get("description", "") or "",
            # what to call the subject after its first appearance, when there is no
            # <Subject N> label to name it with. Empty repeats the description, which is
            # what every timeline written before this field did.
            "short_name": (info.get("shortName", "") or "").strip(),
            "kind": sanitize_kind(info.get("kind")),
            "retention": sanitize_retention(info.get("retention")),
            "note": info.get("retentionNote", "") or "",
            # a voice reference that belongs to the subject, not to the timeline
            "voice": _clean_voice(info.get("voice")),
        })

    # --- shots + image events ---
    shots, events = [], []
    if retake:
        # Retake replaces the timeline window: one shot over the marked range, anchored on
        # the base video's own frames either side of it.
        text = retake["prompt"].strip()
        if not text:
            for seg in sorted(tdata.get("segments", []) or [],
                              key=lambda s: float(s.get("start", 0))):
                if overlaps(seg, win_start, win_end) and (seg.get("prompt") or "").strip():
                    text = seg["prompt"]
                    break
        text, spoken = split_dialogue(text)
        shots.append({"prompt": text, "dialogue": spoken,
                      "start_sec": 0.0, "end_sec": window_seconds})
    else:
        segments = [s for s in (tdata.get("segments", []) or [])
                    if overlaps(s, win_start, win_end)]
        segments.sort(key=lambda s: float(s.get("start", 0)))
        for seg in segments:
            seg_start = float(seg.get("start", 0))
            seg_len = float(seg.get("length", 1))
            rel_start = max(0.0, seg_start - win_start)
            rel_end = min(float(duration_frames), seg_start + seg_len - win_start)
            # dialogue is lifted before anything else touches the text, so a shot
            # whose whole content is a spoken line still becomes a numbered shot
            prose, spoken = split_dialogue(seg.get("prompt", "") or "")
            shots.append({"prompt": prose, "dialogue": spoken,
                          "start_sec": rel_start / fps, "end_sec": rel_end / fps})

            kind = seg.get("type", "image")
            if kind not in ("image", "video"):
                continue
            if not (seg.get("imageFile") or seg.get("imageB64")):
                continue
            events.append({"seg": seg, "rel_start_f": rel_start, "rel_end_f": rel_end,
                           "is_end": bool(seg.get("isEndFrame")), "kind": kind,
                           "name": seg.get("fileName", "") or "", "role": ROLE_MIDDLE,
                           # which shot this image belongs to, so a picture note can name
                           # it the way the guide does. Resolved to the *written* shot
                           # numbering below — the body only numbers shots that carry text.
                           "shot_index": len(shots) - 1})
        classify_events(events, duration_frames, fps)

    # --- reference ordinals, in the order the tokenizer will present them ---
    char_tag_values = {}
    char_tag_later = {}      # what a tag resolves to after its first appearance
    ref_notes = []
    ref_image_slots = []     # {"source": "char"/"input"/"timeline", ...} in <Picture i> order

    if ref_mode_on:
        for slot_idx, slot in enumerate(subject_slots):
            if not slot["images"] or len(ref_image_slots) >= MAX_REF_IMAGES:
                continue
            for img in slot["images"]:
                if len(ref_image_slots) >= MAX_REF_IMAGES:
                    break
                ref_image_slots.append({"source": "char", "slot": slot_idx, "image": img})

        # Images arriving through the `ref_images` input used to be numbered and never
        # described — they took a <Picture N> and the prompt said nothing about what was
        # in them, which is the one thing the model needed. One line of `ref_image_notes`
        # per image fills that in, in the guide's own sentence shape
        # ("<Picture 3> is a storyboard reference for [Shot 1] …"). Blank lines are kept as
        # placeholders so line 3 always describes the third image (issue #8).
        #
        # The line is kept on the slot rather than written out here, because every other
        # declaration is built once the caps have trimmed: a note written at this point
        # would describe a picture that may not survive to be sent.
        notes = [n.strip() for n in (ref_image_notes or "").splitlines()]
        for index in range(max(0, int(extra_ref_image_count))):
            if len(ref_image_slots) >= MAX_REF_IMAGES:
                break
            text = notes[index] if index < len(notes) else ""
            ref_image_slots.append({"source": "input", "desc": text})

        # Timeline images in the order they appear on the timeline. `events` is already
        # chronological, so <Picture n> counts up with time. Character slots and the
        # ref_images input stay ahead of all of them, so a character's number never shifts
        # when an image is dropped on the timeline.
        #
        # The wording is the reference guide's own, verbatim where it gives it:
        # "the shot begins from <Picture 1>", "the shot's keyframe corresponds to
        # <Picture 2>", "the shot ends on <Picture 3>". `<Picture N>` is precisely what
        # that guide asks for when an image "serves as a shot's first frame, keyframe,
        # last frame, edited keyframe, or composition anchor", so ref2va does have frame
        # anchors in its notation — what it does not have is FL2VA's vocabulary. Calling
        # these "opening frame" / "closing frame" borrowed from the wrong guide, and made
        # the phrasing depend on where a segment happened to end: flush with the window it
        # read as a closing frame, three frames shorter as something else entirely
        # (issue #4).
        #
        # Shots are named the way the body names them, which counts only shots carrying
        # text. An image whose own segment has no prompt gets the guide's shot-free
        # phrasing rather than a number the reader cannot find.
        #
        # Only what the wording will be *derived from* is recorded here. The sentences
        # themselves are built after the total-file cap has trimmed the list, so a
        # reference that did not survive never had a note to prune — the old code wrote
        # the notes first and then parsed the strings back apart to drop them again.
        #
        # `picture_role` is what the image does inside *its own shot*; `ref_role` is what
        # the user says the image is *for*. Only an untouched `auto` image is a real
        # keyframe: that flag is not about wording at all, it picks which frame of a video
        # segment becomes the reference and whether it is fitted to the canvas. See
        # minimax_director.py.
        #
        # The fl2va anchor roles are deliberately not consulted here. One timeline segment
        # is one shot and the image opens it, so a picture is what its shot begins from —
        # including the last one on the timeline, which starts the final shot rather than
        # ending the video. Reading `last` off the fl2va classifier announced a hard cut's
        # opening image as what the shot "ends on", and made the wording depend on whether
        # a segment happened to finish flush with the window: three frames shorter and the
        # same image was something else entirely. `ends on` is now reserved for a segment
        # explicitly flagged as an end frame, the only place that intention is stated
        # rather than inferred from geometry.
        written_shot_no = {}
        counted = 0
        for shot_i, shot in enumerate(shots):
            if shot_has_text(shot):
                counted += 1
                written_shot_no[shot_i] = counted

        for ev in events:
            if len(ref_image_slots) >= MAX_REF_IMAGES:
                break
            seg = ev["seg"]
            ref_role = sanitize_ref_role(seg.get("refRole"))
            if ref_role == REF_ROLE_AUTO:
                # "frame anchor" now means what it says: the image is a frame of the video,
                # so it is sent as one, conditioned at its own position by the anchor pass
                # below. A <Picture N> entry as well would be the same image twice, once as
                # a frame and once as something the model is only shown — and it would spend
                # one of the nine reference slots on a job it is no longer doing.
                continue
            shot_no = written_shot_no.get(ev.get("shot_index"))
            if ev["is_end"]:
                picture_role = ROLE_LAST
            elif shot_no:
                picture_role = ROLE_FIRST
            else:
                # no text on its own segment, so there is no [Shot N] to point at and
                # nothing it can be said to open: it is an anchor, and stays uncropped
                picture_role = ROLE_MIDDLE
            slot = {"source": "timeline", "event": ev, "ref_role": ref_role,
                    "picture_role": picture_role,
                    "kind": sanitize_kind(seg.get("refKind")),
                    "retention": sanitize_retention(seg.get("retention")),
                    "desc": (seg.get("refDesc") or "").strip(),
                    "note": (seg.get("refNote") or "").strip(),
                    "shot_no": shot_no,
                    "at": fmt_seconds(ev["rel_start_f"] / fps)}
            if ref_role == REF_ROLE_PICTURE and picture_role in (ROLE_FIRST, ROLE_LAST):
                slot["keyframe"] = picture_role
            ref_image_slots.append(slot)
    else:
        # The base guide has no subject_definitions section: with references off, a subject
        # exists only as prose inside integrated_multimodal_description, established "when
        # a speaker first appears" and referred to consistently after that. So the slot's
        # description *is* the definition, dropped in where the tag sits.
        for slot_idx, slot in enumerate(subject_slots):
            if slot["description"]:
                char_tag_values[slot_idx + 1] = slot["description"]
                if slot["short_name"]:
                    char_tag_later[slot_idx + 1] = slot["short_name"]

    # --- reference video / audio tracks ---
    # A reference is an input to the model, not content in the video: <Video N> and <Audio N>
    # are never composited, so neither has any business occupying output time. The model card
    # wants each reference audio clip 10-15s long, and three of those would need a 45s timeline
    # — longer than anything H3 can render. So where a clip sits does not decide whether it is
    # a reference. It decides one thing only: whether an audio clip is *also* part of the muxed
    # soundtrack, which build_combined_audio answers by filling the window and nothing else. A
    # clip parked in the shaded area past the window is a reference and no more than that.
    # (Brioch's PR #18, ported.)
    #
    # Retake is the exception, and stays on the old rule. There the window is a deliberate
    # sub-range of a video that already exists, so outside it means "another part of this
    # same video" rather than "parked" — and the editor does not even draw the audio track.
    ref_warnings = []
    ref_video_segs, ref_audio_segs = [], []
    downgraded_full = []
    anchored_motion, anchored_audio = [], []
    over_cap = []
    override_dropped_audio = []

    def take_anchored(segs, sink):
        """Split the clips marked 'frame anchor' off a reference track.

        A clip the user has called a frame anchor is not a reference at all: it is part of
        the video, at the moment it sits on. Which is also why the one thing a reference
        does not need — being inside the window — is the one thing an anchor cannot do
        without. Outside it there is no frame to anchor at, so it is named and left alone.
        """
        kept = []
        for s in segs:
            if not retake and sanitize_clip_role(s.get("refRole")) == REF_ROLE_AUTO:
                if overlaps(s, win_start, win_end):
                    sink.append(s)
                else:
                    ref_warnings.append(
                        "'%s' is marked as a frame anchor but sits outside the render "
                        "window, where there is no frame to anchor it at — move it in, or "
                        "set it back to a reference." % seg_name(s))
                continue
            kept.append(s)
        return kept

    if ref_mode_on:
        if use_custom_motion:
            motion = [s for s in (tdata.get("motionSegments", []) or [])
                      if s.get("videoFile")
                      and (not retake or overlaps(s, win_start, win_end))]
            motion = take_anchored(motion, anchored_motion)
            motion.sort(key=lambda s: float(s.get("start", 0)))
            ref_video_segs = motion[:MAX_REF_VIDEOS]
            over_cap.extend(("video", MAX_REF_VIDEOS, s) for s in motion[MAX_REF_VIDEOS:])
        # A subject's own voice clip is not gated by the audio-track switch: that switch is
        # about the timeline's lane, and a clip dropped on a subject is as deliberate as the
        # subject's image. They go first, so the cap trims timeline clips before them.
        voices = _voice_segs(subject_slots, fps)
        if use_custom_audio or voices:
            audio = [s for s in (tdata.get("audioSegments", []) or [])
                     if use_custom_audio
                     and (s.get("audioFile") or s.get("audioB64"))
                     and not is_audio_lock(s)
                     and (not retake or overlaps(s, win_start, win_end))]
            audio = take_anchored(audio, anchored_audio)
            audio.sort(key=lambda s: float(s.get("start", 0)))
            audio = voices + audio
            # Override Audio and the audio track are two answers to one question — where the
            # sound comes from — and the editor keeps them exclusive. Only a hand-edited or
            # scripted workflow arrives with both, and both cannot be sent: core numbers each
            # reference video's soundtrack <Audio j> *before* the standalone clips, so every
            # label in the prompt would name a different clip than the model was handed.
            # Override Audio wins, as it does in the editor.
            if override_audio and ref_video_segs:
                override_dropped_audio = [seg_name(s) for s in audio]
            else:
                ref_audio_segs = audio[:MAX_REF_AUDIOS]
                over_cap.extend(("audio", MAX_REF_AUDIOS, s) for s in audio[MAX_REF_AUDIOS:])
            # fully_copy means "the complete source audio is the target video's complete final
            # audio track" — there is room for exactly one. A second one would contradict the
            # first, so it is written as partially_copy, which is what copying one of several
            # clips is, and the user is told.
            seen_full = False
            for i, seg in enumerate(ref_audio_segs):
                if sanitize_retention(seg.get("retention"), audio=True) != "fully_copy":
                    continue
                if seen_full:
                    ref_audio_segs[i] = dict(seg, retention="partially_copy")
                    downgraded_full.append(seg_name(seg))
                seen_full = True

    # --- total file cap ---
    # The per-type caps are not the whole story: H3 also takes at most 12 reference files
    # across all types. Trim from the back so the earlier, more deliberate references win.

    # The panel keeps its images either way, so switching the toolbar back does not cost
    # the work — but on this path they are never sent, and a slot that looks filled and
    # does nothing is worth one line.
    if not ref_mode_on:
        unsent = sum(1 for s in subject_slots if s["images"])
        if unsent:
            ref_warnings.append(
                "%d subject slot(s) hold reference images; fl2va sends none of them. Only "
                "the written description reaches the prompt." % unsent)

    # Locked clips are independent of the reference mode: the audio stream is the model's own
    # in either checkpoint, so this works for fl2va as well, where there is no <Audio N>.
    lock_audio_segs = []
    if use_custom_audio and not retake:
        lock_audio_segs = sorted(
            (s for s in (tdata.get("audioSegments", []) or [])
             if is_audio_lock(s) and (s.get("audioFile") or s.get("audioB64"))
             and overlaps(s, win_start, win_end)),
            key=lambda s: float(s.get("start", 0)))

    if downgraded_full:
        ref_warnings.append(
            "fully_copy means a clip is the video's complete final audio track, so only one clip can "
            "have it; written as partially_copy instead: %s."
            % ", ".join("'%s'" % n for n in downgraded_full))

    # Audio on the timeline that never reaches the model is the easiest thing here to mistake
    # for a bug: the clip sits in the lane, the mixdown on `combined_audio` carries it, and
    # the generated soundtrack is the model's own. Name which of the two it is.
    audio_on_timeline = [s for s in (tdata.get("audioSegments", []) or [])
                         if (s.get("audioFile") or s.get("audioB64"))
                         and not is_audio_lock(s)
                         and overlaps(s, win_start, win_end)]
    # On fl2va the track guides the model through frame anchors, further down, and on ref2va
    # a clip marked as a frame anchor is sent as one.
    audio_anchored = bool(anchored_audio) or (
        not ref_mode_on and use_custom_audio and not override_audio and not retake)
    if (audio_on_timeline and not audio_anchored
            and not any(not s.get("voice_slot") for s in ref_audio_segs)):
        if ref_mode_on or not use_custom_audio:
            why = "the audio track is switched off"
        else:
            why = "references are off (fl2va), which has no audio input at all"
        ref_warnings.append(
            "%d audio clip(s) on the timeline are not sent to the model: %s. They are only in "
            "`combined_audio`; wire that into CreateVideo to hear the clip itself, set the clip "
            "to \"lock\" so the model builds the video around it, or use Refs ON with the audio "
            "track enabled so the model gets it as an <Audio> reference."
            % (len(audio_on_timeline), why))

    total_files = len(ref_image_slots) + len(ref_video_segs) + len(ref_audio_segs)
    if total_files > MAX_REF_FILES:
        excess = total_files - MAX_REF_FILES
        for bucket, label in ((ref_audio_segs, "audio"), (ref_video_segs, "video"),
                              (ref_image_slots, "image")):
            while excess > 0 and bucket:
                bucket.pop()
                excess -= 1
        ref_warnings.append(
            "H3 takes at most %d reference files in total; %d were dropped."
            % (MAX_REF_FILES, total_files - MAX_REF_FILES))

    # reference videos: each 2-15s, and no more than 15s of them together
    if ref_video_segs:
        budget = REF_VIDEO_TOTAL_SEC
        kept = []
        for seg in ref_video_segs:
            seconds = max(0.0, float(seg.get("length", 0)) / fps)
            if seconds < REF_VIDEO_MIN_SEC:
                ref_warnings.append(
                    "Reference video '%s' is %.1fs; H3 wants 2-15s per clip."
                    % (seg_name(seg), seconds))
            # what this clip would actually contribute, after the per-clip cap
            usable = min(seconds, REF_VIDEO_MAX_SEC)
            # the question is whether it FITS, not whether anything is left at all
            if usable > budget + 1e-6:
                ref_warnings.append(
                    "Reference videos exceed the %.0fs total budget; '%s' was dropped."
                    % (REF_VIDEO_TOTAL_SEC, seg_name(seg)))
                continue
            kept.append(seg)
            budget -= usable
        ref_video_segs = kept

    # Both per-type caps used to trim in silence, which is the one thing a reference limit is
    # not allowed to do — every other one names what it dropped. Parking clips off the window
    # is what makes this worth saying: a fourth clip out in the shade looks exactly as loaded
    # as the three that are being sent.
    for kind, cap, seg in over_cap:
        ref_warnings.append("H3 takes at most %d reference %s clips; '%s' was dropped."
                            % (cap, kind, seg_name(seg)))

    # Parked audio gets no warning: being a reference and not a soundtrack is the whole point
    # of parking it, and a line that fires on every timeline of a kind is how a warnings area
    # stops being read. Override Audio is different — two explicit choices contradict each
    # other there.
    if override_dropped_audio:
        ref_warnings.append(
            "Override Audio and the audio track are two answers to one question, and the "
            "editor keeps them exclusive; this timeline has both on. Override Audio wins "
            "and these clips were not sent, because <Audio N> counts each reference video's "
            "soundtrack first and every label in the prompt would have named a different "
            "clip: %s." % ", ".join("'%s'" % n for n in override_dropped_audio))
    if override_audio:
        muted = [seg_name(s) for s in ref_video_segs if not overlaps(s, win_start, win_end)]
        if muted:
            ref_warnings.append(
                "Override Audio takes the soundtrack from the reference videos, and these "
                "sit past the render window, so no part of them reaches combined_audio: %s."
                % ", ".join("'%s'" % n for n in muted))

    # --- output length ---
    # Computed before the prompt because the alignment instruction has to name the
    # *effective* duration, i.e. after snapping to the 17k+5 grid, not the window length.
    length = align_frame_count(max(5, int(round(window_seconds * MODEL_FPS))))
    actual_seconds = length / MODEL_FPS

    # --- frame anchors ---
    # Computed here rather than with the events, because where a clip lands is a position in
    # the *output*, and the output's length is only known once the window has been snapped
    # to the grid above.
    #
    # The two paths choose what to anchor differently, and the difference is the whole of
    # it. fl2va has no other use for a timeline image, so a middle is anchored on sight.
    # ref2va does — an image can be a <Picture N>, a storyboard, or a subject — so there the
    # user says which, and only "frame anchor" means a frame.
    audio_anchors, video_anchors = [], []

    def clip_anchor(seg, clip=False):
        """Where a reference-track clip lands, and how much of it is sent."""
        seg_start = float(seg.get("start", 0))
        rel_start = max(0.0, seg_start - win_start)
        rel_end = min(float(duration_frames), seg_start + float(seg.get("length", 1)) - win_start)
        idx = max(0, min(int(round(rel_start / fps * MODEL_FPS)), length - 1))
        anchor = {
            "seg": seg,
            # a clip that begins before the window is anchored at its first frame inside it,
            # with the part already gone trimmed off the front
            "head_trim_f": max(0.0, win_start - seg_start),
            "anchor_frame": idx,
        }
        if clip:
            span = int(round((rel_end - rel_start) / fps * MODEL_FPS))
            anchor["anchor_clip_frames"] = anchor_clip_frames(min(span, length - idx))
        return anchor

    if not retake:
        if ref_mode_on:
            anchored_events = [e for e in events
                               if sanitize_ref_role(e["seg"].get("refRole")) == REF_ROLE_AUTO]
            skipped = anchor_events(anchored_events, length, fps, ends_reserved=False)
            video_anchors = [clip_anchor(s, clip=True) for s in anchored_motion]
            audio_anchors = [clip_anchor(s) for s in anchored_audio]
        else:
            skipped = anchor_events(events, length, fps)
            # The audio track guides the model as well as filling combined_audio, on the
            # same switch that governs it in ref2va — where it decides whether a clip
            # becomes an <Audio j>. Without a switch of its own every timeline that has ever
            # had a sound on it would start conditioning on it, which is a different render
            # with nothing on screen to say why. Override Audio wins here as it does
            # everywhere else: it is the answer to where the sound comes from, and the track
            # is not it.
            if use_custom_audio and not override_audio:
                audio_anchors = [
                    clip_anchor(s) for s in
                    sorted((tdata.get("audioSegments", []) or []),
                           key=lambda s: float(s.get("start", 0)))
                    if (s.get("audioFile") or s.get("audioB64"))
                    and not is_audio_lock(s)
                    and overlaps(s, win_start, win_end)]

        for ev in skipped:
            ref_warnings.append(
                "'%s' lands on a frame another image is already anchored at, so it was not "
                "sent — move it, or take the other one off that frame."
                % seg_name(ev["seg"]))

    # --- reference labels ---
    # Built after the caps have done their trimming, so every declaration describes a
    # reference that is actually being sent.
    subject_lines, subject_of_slot, ref_labels, pic_texts = [], {}, [], {}
    if ref_mode_on:
        (subject_lines, subject_of_slot, ref_labels, pic_texts,
         subject_notes) = build_subject_definitions(
            subject_slots, ref_image_slots, ref_video_segs, ref_audio_segs)
        # the comfyui format has no sections to put any of this in, so it keeps the one
        # flat notes line — which is the same set of facts in the guide's older phrasing.
        # Subjects go in front of the pictures: this format resolves a tag to the bare
        # <Picture N> that shows the subject, so a description typed into a slot had
        # nowhere at all to go and was simply dropped (issue #14).
        ref_notes = subject_notes + [pic_texts[o]["note"] for o in sorted(pic_texts)]

        # A slot whose pictures were all trimmed away must not keep pointing at an ordinal
        # that no longer exists; it falls back to its description, exactly as it would
        # with references off.
        char_tag_values, char_tag_later = {}, {}
        for slot_index, slot in enumerate(subject_slots):
            ordinals = [i + 1 for i, s in enumerate(ref_image_slots)
                        if s.get("source") == "char" and s.get("slot") == slot_index]
            if ordinals:
                char_tag_values[slot_index + 1] = "<Picture %d>" % ordinals[0]
            elif slot["description"]:
                # no picture, so no label — this slot is prose here too, and takes the
                # base guide's first-in-full-then-a-handle treatment with it
                char_tag_values[slot_index + 1] = slot["description"]
                if slot["short_name"]:
                    char_tag_later[slot_index + 1] = slot["short_name"]

        if prompt_format == FORMAT_MINIMAX:
            # a named subject beats a bare picture label: it survives across cuts
            for slot, subject in subject_of_slot.items():
                char_tag_values[slot] = "<Subject %d>" % subject

    # A line meant to be spoken that the dialogue rule did not claim, reported before the
    # tags resolve — afterwards there is no "@ref1" left to point at, only the label it
    # became. The shot number is the body's, which counts only shots carrying text.
    near_miss_no = 0
    for shot in shots:
        if not shot_has_text(shot):
            continue
        near_miss_no += 1
        for line, reason in near_miss_dialogue(shot["prompt"]):
            if reason == "alias":
                ref_warnings.append(
                    "[Shot %d] `%s` names a subject with @char, which does not speak. Write "
                    "@ref%s for a spoken line, so it gets a speaker ID and <d>[Language] …</d>."
                    % (near_miss_no, line, NEAR_MISS_ALIAS_RE.match(line).group(1)))
            else:
                ref_warnings.append(
                    "[Shot %d] `%s` reads as dialogue but has no colon, so it stayed narration "
                    "— no speaker ID, no <d>[Language] …</d>. Dialogue is `@ref1 <how it is "
                    "said>: the words`." % (near_miss_no, line))

    # Left to right through the finished video — `summary`, then the global block, then
    # each shot in turn, its prose before its dialogue. `seen_slots` is what makes "the
    # first appearance" mean the first one anywhere rather than the first one in this
    # particular string: a subject that speaks in shot 1 and is described in shot 2 is
    # introduced by its spoken line, not re-introduced afterwards.
    #
    # Speakers are numbered in the same pass, which also has to happen after the tags
    # resolve to their labels and before the shot text is read back for
    # `(appears in [Shot N])` — a subject that only ever speaks still appears in the
    # shots where it speaks.
    seen_slots = set()

    # `summary` is a box like any other, so a tag typed in it has to resolve like any
    # other — it reached the model as a literal "@ref1" before this. It goes first because
    # the guide's section order puts it above detailed_description, which is what "first
    # appearance" has to mean here. Only ref2va emits the section: substituting it on the
    # fl2va path would mark a slot as already introduced on the strength of a sentence
    # that never gets written out, and the global prompt would then open with a short name
    # for someone nothing had named yet.
    summary_text = (summary or "").strip() or (tdata.get("summary", "") or "").strip()
    if ref_mode_on:
        summary_text = substitute_char_tags(summary_text, char_tag_values, char_tag_later,
                                            seen_slots)

    global_prompt = substitute_char_tags(global_prompt, char_tag_values, char_tag_later,
                                         seen_slots)

    def label_for_slot(slot):
        value = char_tag_values.get(slot)
        if slot in seen_slots:
            value = char_tag_later.get(slot) or value
        seen_slots.add(slot)
        return value

    speaker_ids = {}
    for shot in shots:
        render_shot(shot, char_tag_values, char_tag_later, seen_slots, speaker_ids,
                    label_for_slot)

    # Now that every speaker has an ID, the voice-reference declarations can end the way the
    # guide ends them. Only the panel-slot speakers map onto subjects — a @voice(…) speaker
    # has no <Subject N> to be the timbre reference for.
    speaker_of_subject = {subject_of_slot[slot]: speaker
                          for (kind, slot), speaker in speaker_ids.items()
                          if kind == "slot" and slot in subject_of_slot}
    apply_speaker_ids(subject_lines, ref_labels, speaker_of_subject)
    slot_of_subject = {subject: slot for slot, subject in subject_of_slot.items()}

    # only the minimax format has a detailed_description to measure; the key exists either
    # way so every caller can read it without checking the format first
    description_words = 0

    if prompt_format == FORMAT_MINIMAX:
        # the guide keeps the soundtrack out of the shot description
        global_prompt, found_audio, found_music = split_audio_music(global_prompt)
        # A filled box wins, but the lifted line is then thrown away — and it may be work
        # the Enhance node's vision model just did. Say so rather than swallow it.
        for label, box, found in (("overall_soundscape", soundscape, found_audio),
                                  ("non_diegetic_music", music, found_music)):
            if (box or "").strip() and found:
                log.info("[MiniMaxDirector] %s came from the timeline box, so the %s line "
                         "in the prompt text was dropped.", label,
                         "Audio:" if label == "overall_soundscape" else "Music:")
        soundscape = (soundscape or "").strip() or found_audio
        music = (music or "").strip() or found_music

        # A copied clip has to be declared in the two sound sections too, not only in
        # retention_analysis. Measured: with fully_copy in retention_analysis and
        # `non_diegetic_music: N/A` the generated audio had no relation to the clip (envelope
        # correlation 0.17), and with nothing but these two lines added it was the clip
        # (0.98). The guide says as much: "state its copy or reference relationship ... in the
        # section that matches the audible layer". Written text still wins.
        copied = [("<Audio %d>" % (i + 1),
                   sanitize_retention(seg.get("retention"), audio=True))
                  for i, seg in enumerate(ref_audio_segs)
                  if sanitize_retention(seg.get("retention"), audio=True)
                  in ("fully_copy", "partially_copy")]
        if copied:
            names = " and ".join(label for label, _ in copied)
            whole = all(marker == "fully_copy" for _, marker in copied)
            if not soundscape:
                soundscape = ("The ambience and any voice in %s are copied and continue "
                              "throughout the target video." % names if whole else
                              "The copied layer from %s plays in its place on the timeline; "
                              "the rest of the sound is generated." % names)
            if not music:
                music = ("%s is directly reused as the complete audience-only score." % names
                         if whole else
                         "Part of %s is directly reused as the audience-only score." % names)

        # Which shots each subject actually turns up in, read back off the shot text now
        # that the tags have been substituted. Numbering matches the body, which counts
        # only shots carrying text.
        subject_shots = {}
        written_no = 0
        for shot in shots:
            if not shot_has_text(shot):
                continue
            written_no += 1
            # dialogue counts: a subject that only ever speaks still appears in that shot
            body = shot.get("text") or ""
            for entry in ref_labels:
                num = entry.get("subject")
                if num and entry["label"] in body:
                    subject_shots.setdefault(num, []).append(written_no)

        retention_lines = build_retention_analysis(ref_labels, subject_shots)
        # "Do not write (Sx) in retention_analysis" — the IDs belong to vocal events in
        # detailed_description. Only a hand-written note can put one here, so say so
        # rather than quietly editing what was typed.
        if any(SPEAKER_ID_RE.search(line) for line in retention_lines):
            ref_warnings.append(
                "A speaker ID (Sx) appears in retention_analysis; the guide reserves those "
                "for detailed_description.")

        # guide 5.3: name the frame anchor inside the shot as well as declaring it above
        for ordinal, texts in pic_texts.items():
            if not texts["phrase"]:
                continue
            shot_index = ref_image_slots[ordinal - 1]["event"].get("shot_index")
            if shot_index is not None and 0 <= shot_index < len(shots):
                shots[shot_index].setdefault("ref_phrases", []).append(texts["phrase"])

        # `summary` is the reference guide's section. The base guide's structure is
        # explicit and closed — the alignment instruction, then "Three Core Fields
        # (Required, in this order)" — so on the fl2va path a summary line would be a
        # section H3 was never trained to read there. The box keeps its text for when the
        # toolbar goes back.
        summary_line = ""
        if ref_mode_on:
            summary_line = " ".join(x for x in (
                task_type_prefix(ref_image_slots, ref_video_segs, ref_audio_segs,
                                 tdata.get("task_type_override"),
                                 anchored=any(e.get("anchor_frame") is not None
                                              for e in events)),
                summary_text,
            ) if x)

        # Only the fl2va path: ref2va has no keyframe slot and its guide asks for no
        # instruction line. `written` mirrors the shot numbering the body will use.
        instruction = ""
        if not ref_mode_on:
            written_shots = len([s for s in shots if shot_has_text(s)])
            instruction = alignment_instruction(
                any(e["role"] == ROLE_FIRST for e in events),
                any(e["role"] == ROLE_LAST for e in events),
                written_shots, actual_seconds)
        prompt = compile_storyboard_minimax(global_prompt, shots, soundscape, music,
                                            subject_lines, retention_lines, instruction,
                                            summary_line)

        # Measured on detailed_description alone — the label blocks and the sound sections
        # are not what the guide is counting.
        #
        # Reported as a figure, not a warning. The guide's 350-500 is a lot of words for a
        # 5-15 second clip, so being under it is the ordinary state here rather than a
        # fault: warning about it fired on essentially every timeline, which is how a
        # warning area stops being read at all. Only overshooting the range is called out,
        # where the prompt really has outgrown what the guide describes.
        description_words = len(global_prompt.split()) + sum(
            len((s.get("text") or "").split()) for s in shots if shot_has_text(s))
        #
        # Only on the reference path: 350-500 is that guide's figure for its own
        # detailed_description. The base guide gives no word count at all, so citing one
        # there would put words in its mouth. The figure is still reported either way.
        if ref_mode_on and description_words > DESCRIPTION_MAX_WORDS:
            ref_warnings.append(
                "detailed_description is about %d words; the guide suggests %d-%d for "
                "generation tasks."
                % (description_words, DESCRIPTION_MIN_WORDS, DESCRIPTION_MAX_WORDS))

        # Both guides list the three core fields as required, and this is the one that
        # cannot be filled in for the user: "N/A" here means the video was asked to be
        # silent, which is a claim only the user can make. H3 generates the audio, so
        # leaving it out hands the whole soundtrack to the model's guess.
        if not (soundscape or "").strip():
            ref_warnings.append(
                "overall_soundscape is empty; the guide lists it as a required field. "
                "Describe the ambience, or write N/A if the video is meant to be silent.")

        # The same rule for the field that carries the whole video. Unlike the soundscape
        # there is no N/A for it: a prompt with no detailed_description has described nothing,
        # and the section is simply absent from the output rather than visibly empty.
        if not description_words:
            ref_warnings.append(
                "detailed_description is empty; the guide lists it as a required field. "
                "Write what happens in the global prompt box or on a timeline segment.")

        # A voice-timbre reference for someone who never speaks. The guide's declaration
        # "reuses the same (Sx) but never assigns a new one independently", so with no vocal
        # event there is no ID to reuse and the sentence ends on the label — correct, and
        # baffling if nothing says why.
        for entry in ref_labels:
            subject = entry.get("voice_of")
            if not subject or subject in speaker_of_subject:
                continue
            ref_warnings.append(
                "%s is the voice of <Subject %d>, who has no spoken line, so the guide's "
                "speaker ID could not be reused in its definition. Write the line as "
                "`@ref%s says: …` to give them one."
                % (entry["label"], subject, slot_of_subject.get(subject, "N")))
    else:
        prompt = compile_storyboard(global_prompt, shots, window_seconds)
        if ref_notes:
            prompt = (prompt + "\n\nReference notes: " + "; ".join(ref_notes) + ".").strip()
        if (soundscape or "").strip():
            prompt = (prompt + "\n\nAudio: " + soundscape.strip()).strip()
        if (music or "").strip():
            prompt = (prompt + "\n\nMusic: " + music.strip()).strip()

    # A hand-written prompt replaces the compiled text and nothing else. Which images,
    # videos and audio clips get loaded still comes from the timeline, because those are
    # not opinions — the tokenizer emits <Picture i> in the order the plan decided, and a
    # rewritten sentence cannot change that without silently renumbering everything the
    # user just wrote. So the override is the last step, over the finished string.
    #
    # It is stored rather than merged on purpose. There is no honest way to fold an edit
    # back into a recompile: dropping it when the timeline moves loses work without
    # asking, keeping it while the timeline says otherwise is a prompt that quietly stops
    # matching what is on screen. Storing it makes the state visible and reversible, which
    # is the only version of this that can be explained to someone a week later.
    compiled_prompt = prompt
    override = (tdata.get("prompt_override") or "") if tdata.get("prompt_override_on") else ""
    overridden = bool(override.strip())
    if overridden:
        prompt = override.strip()

    fallback = not prompt
    if fallback:
        prompt = "video"

    # An anchored image is a keyframe like any other — it is the same cond block at another
    # position — so a window whose only image sits in the middle is fl2va, not t2va.
    has_keyframe = (any(ev["role"] in (ROLE_FIRST, ROLE_LAST) for ev in events)
                    or any(ev.get("anchor_frame") is not None for ev in events)
                    or bool(audio_anchors) or bool(video_anchors) or bool(retake))
    mode = "ref2va" if ref_mode_on else ("fl2va" if has_keyframe else "t2va")

    return {
        "prompt": prompt, "prompt_is_fallback": fallback,
        "prompt_overridden": overridden, "compiled_prompt": compiled_prompt,
        "shots": shots, "events": events, "retake": retake,
        "ref_mode_on": ref_mode_on, "mode": mode,
        # Which panel slot became which <Subject N>, keyed by 1-based slot. Not the slot
        # number: only slots that hand over a reference image are numbered, so slot 2 is
        # <Subject 1> when slot 1 is empty. The editor needs the answer to label its own
        # menus, and working it out there would be a second copy of this rule.
        "subject_of_slot": subject_of_slot,
        "ref_image_slots": ref_image_slots, "ref_notes": ref_notes,
        "ref_video_segs": ref_video_segs, "ref_audio_segs": ref_audio_segs,
        "lock_audio_segs": lock_audio_segs,
        # Image anchors ride on the events themselves, as `anchor_frame` /
        # `anchor_clip_frames`; the audio track has no event of its own, so its anchors are
        # a list here. Both are empty on ref2va and in a retake.
        "audio_anchors": audio_anchors, "video_anchors": video_anchors,
        "ref_warnings": ref_warnings, "prompt_format": prompt_format,
        "description_words": description_words,
        "char_tag_values": char_tag_values,
        "win_start": win_start, "duration_frames": duration_frames, "fps": fps,
        "window_seconds": window_seconds,
        "length": length, "actual_seconds": actual_seconds,
    }
