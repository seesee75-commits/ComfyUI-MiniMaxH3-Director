# 2 · Models and files

Every workflow carries the download links of its models. When a file is missing, ComfyUI lists it when the workflow opens
and offers the download. The same list, with what was found on your machine, is in the Director under **Settings →
Models**. Your files may have other names or lie in a subfolder; then choose them in the loader.

![The model loaders](../images/wf2-models.jpg)

## H3 (every workflow)

| What | File (click to download) | Folder | Size |
|---|---|---|---|
| H3 model: First / last frame | [minimax_h3_fl2va_pruned_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors) | `models/diffusion_models` | 19.5 GB |
| H3 model: References | [minimax_h3_ref2va_pruned_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors) | `models/diffusion_models` | 19.5 GB |
| H3 text encoder | [qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors) | `models/text_encoders` | 14.6 GB |
| H3 video VAE | [minimax_h3_video_vae_fp16.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors) | `models/vae` | 4.9 GB |
| H3 audio VAE | [minimax_h3_audio_vae_fp32.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors) | `models/vae` | 0.6 GB |
| Preview VAE (taeh3) | [taeh3.safetensors](https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors) | `models/vae_approx` | 0.02 GB |

Only the model a render part needs is loaded. A text-only project never loads the References model; a project with
character pictures never loads the First / last frame model.

## Turbo

| What | File (click to download) | Folder | Size |
|---|---|---|---|
| Turbo LoRA: First / last frame | [minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors) | `models/loras` | 1.8 GB |
| Turbo LoRA: References | [minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors) | `models/loras` | 1.8 GB |

They are chosen in **Settings → Turbo**. A known LoRA brings its own steps, sampler and scheduler (with 4 steps the
References LoRA leaves a white veil; 6 are clean). Other LoRAs work too; then the Director's own steps are used.

## Control videos and masks (Workflows 7 and 8)

| What | File (click to download) | Folder | Size |
|---|---|---|---|
| ControlNet (Fun Union 2.0) | [minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/model_patches/minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors) | `models/model_patches` | 4.2 GB |
| SAM3 | [sam3.1_multiplex_fp16.safetensors](https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors) | `models/checkpoints` | 1.8 GB |
| Pose: person detector | [rt_detr_v4-x-hgnet_fp16.safetensors](https://huggingface.co/Comfy-Org/SDPose/resolve/main/diffusion_models/rt_detr_v4-x-hgnet_fp16.safetensors) | `models/diffusion_models` | 0.1 GB |
| Pose: keypoints | [sdpose_wholebody_fp16.safetensors](https://huggingface.co/Comfy-Org/SDPose/resolve/main/checkpoints/sdpose_wholebody_fp16.safetensors) | `models/checkpoints` | 1.9 GB |
| Depth (MoGe) | [moge_2_vitl_normal_fp16.safetensors](https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors) | `models/geometry_estimation` | 0.7 GB |
| Depth (Depth Anything 3) | `da3_base.safetensors` | `models/depthanything3` | 0.5 GB |

Depth Anything 3 is optional and needs the **ComfyUI-DepthAnythingV3** nodes, which download their model themselves.

## Pictures, storyboard and places (Workflows 5 and 6)

| What | File (click to download) | Folder | Size |
|---|---|---|---|
| Qwen Image 2.1 | [qwen_image_2.1_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) | `models/diffusion_models` | 7.3 GB |
| Qwen Image text encoder | [qwen3vl_8b_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) | `models/text_encoders` | 9.4 GB |
| Qwen Image VAE | [qwen_image_2.1_vae_bf16.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) | `models/vae` | 0.7 GB |
| Background removal | [birefnet.safetensors](https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors) | `models/background_removal` | 0.4 GB |

## Sound

| What | File (click to download) | Folder | Size |
|---|---|---|---|
| Whisper | [small.pt](https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794/small.pt) | `models/whisper` | 0.5 GB |

Whisper needs the `openai-whisper` package in ComfyUI's Python. Larger models (`medium.pt`, `large-v3.pt`) hear sung words
better.

## Example files

The pictures, voice, song and videos of the example workflows come with the node pack (`example_media`). When you open
an example workflow, the files it uses are copied into ComfyUI's `input` folder, named `h3-example-…`; a file of the same
name that is already there is kept. Nothing is copied on start, and files you delete come back only when you open an
example that needs them.

## Little VRAM?

- **Render part: 5 s** in the Settings: smaller parts need less memory.
- The int8 video VAE [minimax_h3_video_vae_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors) instead of the fp16 one.
- A smaller **Resolution** (*Fast*: short side 480).
