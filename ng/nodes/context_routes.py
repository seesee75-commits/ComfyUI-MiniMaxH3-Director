"""Local preset, preview, provider-description and key routes for the context cards."""
import asyncio

from aiohttp import web
from server import PromptServer

import comfy.model_management

from ..adapters import control_files, example_media, keys, lyrics_timing, model_files, models, presets, preview_media, waveform
from ..core import providers
from ..core.context_build import item_from_widgets
from ..core.presets import ContextPreset, widget_values


def key_root(request):
    """Where the keys live. Same place as the context presets: the requesting ComfyUI user's own
    folder, which is outside every workflow file and outside anything that gets shared."""
    return PromptServer.instance.user_manager.get_request_user_filepath(request, "minimax_h3_ng/api_keys")


@PromptServer.instance.routes.get("/ng/providers")
async def list_providers(request):
    """The single list the panel builds its dropdowns and its field visibility from.

    Answers from the registry and nothing else: no network, no key, nothing the user typed. If
    the panel had to know an address or a field name on its own, that would be the second place
    to correct when a provider changes, and the two would drift.
    """
    return web.json_response(providers.describe())


@PromptServer.instance.routes.post("/ng/models")
async def list_models(request):
    """Ask the provider which models it serves. Needs network and often a key, which is why it is
    its own route and not part of /ng/providers.

    The reply says where the names came from (`live`) and carries the key nowhere: the panel
    receives names, never the secret it was resolved with.
    """
    try:
        data = await request.json()
        provider = data.get("provider", "")
        root = key_root(request)
        key = keys.resolve(root, provider, _fallback_key(data))
        names, reason = await models.listing(provider, data.get("base_url", ""), key)
    except (ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "models": [], "reason": str(error)}, status=400)
    return web.json_response({"ok": not reason, "models": names, "reason": reason, "source": "live",
                            # A listing that worked proves the address, not the key: OpenRouter
                            # answers /v1/models either way. The panel shows "key untested" rather
                            # than a green tick the user would read as "the key is good".
                            "key_checked": providers.key_is_checked_on_listing(provider)})


def _fallback_key(data):
    """The env-var route, so a user who already sets OPENROUTER_API_KEY keeps working unchanged."""
    import os
    for name in (data.get("key_env") or "", "OPENROUTER_API_KEY", "OPENAI_API_KEY"):
        if name and os.environ.get(name):
            return os.environ[name]
    return None


@PromptServer.instance.routes.get("/ng/keys")
async def read_keys(request):
    """Which providers have a key stored. Never the key itself, not even partially."""
    try:
        return web.json_response({"ok": True, "keys": keys.describe(key_root(request))})
    except (OSError, ValueError) as error:
        return web.json_response({"ok": False, "keys": {}, "reason": str(error)}, status=400)


@PromptServer.instance.routes.post("/ng/keys")
async def write_keys(request):
    """Store or clear one key. An empty key removes it, which is how a user forgets one."""
    try:
        data = await request.json()
        stored = await asyncio.to_thread(keys.write, key_root(request), data.get("provider", ""),
                                        data.get("key", ""), data.get("key_env", ""))
        return web.json_response({"ok": True, "stored": stored, "keys": keys.describe(key_root(request))})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "reason": str(error)}, status=400)


def preset_root(request):
    return PromptServer.instance.user_manager.get_request_user_filepath(request, "minimax_h3_ng/contexts")


@PromptServer.instance.routes.get("/ng/presets")
async def list_presets(request):
    try:
        names = await asyncio.to_thread(presets.listing, preset_root(request), request.query.get("media", "image"))
        return web.json_response({"ok": True, "names": names})
    except (OSError, ValueError, KeyError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.post("/ng/presets")
async def write_preset(request):
    try:
        data = await request.json()
        item = item_from_widgets(data["media"], data["widgets"])
        preset = ContextPreset.from_dict({"schema_version": 1, "name": data["name"], "item": item.to_dict()})
        await asyncio.to_thread(presets.save, preset_root(request), preset.to_dict())
        return web.json_response({"ok": True, "name": preset.name})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.get("/ng/preset")
async def read_preset(request):
    try:
        preset = await asyncio.to_thread(presets.load, preset_root(request), request.query["name"], request.query["media"])
        if preset.item.media != request.query["media"]:
            raise ValueError("Choose a preset for this context's media type.")
        return web.json_response({"ok": True, "widgets": widget_values(preset.item)})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.get("/ng/media")
async def media_preview(request):
    try:
        data = await asyncio.to_thread(preview_media.preview, request.query["media"], request.query["source"])
        return web.json_response({"ok": True, **data})
    except (OSError, ValueError, KeyError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.post("/ng/control/import")
async def import_control(request):
    try:
        data = await request.json()
        source = await asyncio.to_thread(control_files.import_video, data["filename"], data["subfolder"])
        return web.json_response({"ok": True, "source": source})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.post("/ng/picture/import")
async def import_picture(request):
    """A picture the Image card's editor generated, into the input folder so the card (or a new card) can use it."""
    try:
        data = await request.json()
        source = await asyncio.to_thread(control_files.import_picture, data["filename"], data["subfolder"], data["kind"])
        return web.json_response({"ok": True, "source": source})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.post("/ng/example_media")
async def copy_example_media(request):
    """The example files a workflow being opened names, into the input folder (issue #35: not on start)."""
    try:
        names = (await request.json())["names"]
        if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
            raise ValueError("names must be a list of file names")
        return web.json_response({"ok": True, "copied": await asyncio.to_thread(example_media.copy, names)})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.get("/ng/waveform")
async def media_waveform(request):
    try:
        data = await asyncio.to_thread(waveform.envelope, request.query["source"])
        return web.json_response({"ok": True, **data})
    except (OSError, ValueError, KeyError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.get("/ng/models")
async def model_choices(request):
    """For a card's Models menu: per purpose its entry in js/ng/models.json, the files of its folder and the automatic choice.
    purposes=all answers for every model (the Director's list of all files with their downloads)."""
    asked = request.query.get("purposes", "")
    wanted = list(model_files.MODELS) if asked == "all" else [name for name in asked.split(",") if name in model_files.MODELS]
    return web.json_response({name: {**model_files.MODELS[name], "files": model_files.names(name), "auto": model_files.find(name)}
                              for name in wanted})


@PromptServer.instance.routes.post("/ng/lyrics")
async def time_lyrics(request):
    """Time a song card's lyrics with Whisper. While a render runs it stays off the GPU (CPU is slower, not in the way)."""
    try:
        data = await request.json()
        busy = PromptServer.instance.prompt_queue.get_tasks_remaining() > 0
        device = "cpu" if busy else comfy.model_management.get_torch_device()
        result = await asyncio.to_thread(lyrics_timing.time_lyrics, data["source"], data.get("lyrics", ""), device,
                                         data.get("model", ""))
        comfy.model_management.soft_empty_cache()
        return web.json_response({"ok": True, "device": str(device), **result})
    except (OSError, ValueError, KeyError, TypeError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
