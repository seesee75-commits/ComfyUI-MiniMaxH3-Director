// The example workflows' files (example_media) reach ComfyUI's input folder when a workflow that names them is opened, not on
// start (issue #35: an input folder full of files nobody asked for). ComfyUI waits for beforeConfigureGraph, so the server
// copies the h3-example-* files before the cards are built; the node definitions are then reloaded, so the cards list the
// new files and ComfyUI does not report them as missing.
export function exampleNames(graphData) {
  return [...new Set(JSON.stringify(graphData ?? {}).match(/h3-example-[\w.-]+\.\w+/g) ?? [])].sort();
}

export async function copyExampleMedia(graphData, api, app) {
  const names = exampleNames(graphData);
  if (!names.length) return [];
  try {
    const response = await api.fetchApi("/ng/example_media", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
    const { copied = [] } = await response.json();
    if (copied.length) await app.reloadNodeDefs();
    return copied;
  } catch (error) {
    console.warn("[H3 Director] could not copy the example files to the input folder", error);
    return [];
  }
}

globalThis.comfyAPI?.app?.app?.registerExtension?.({
  name: "mmxd.ng.example_media",
  beforeConfigureGraph(graphData) { return copyExampleMedia(graphData, globalThis.comfyAPI.api.api, globalThis.comfyAPI.app.app); },
});
