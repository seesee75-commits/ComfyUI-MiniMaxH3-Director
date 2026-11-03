import assert from "node:assert/strict";
import fs from "node:fs";
import { exampleNames, copyExampleMedia } from "../../../js/ng/ng_example_media.js";

// The example files are copied when a workflow that names them is opened, not on start (issue #35).
const workflow = JSON.parse(fs.readFileSync(new URL("../../../example_workflows/H3 Director - 6 Storyboard.json", import.meta.url), "utf8"));
const names = exampleNames(workflow);
assert.ok(names.includes("h3-example-storyboard.png") && names.includes("h3-example-panel1.jpg"), "the card files and the storyboard's own");
assert.equal(new Set(names).size, names.length);
assert.deepEqual(exampleNames({ nodes: [{ widgets_values: ["my-own.png"] }] }), [], "a workflow without examples asks for nothing");

const calls = [];
let reloads = 0;
const api = (copied) => ({ fetchApi: async (path, init) => { calls.push([path, JSON.parse(init.body)]); return { json: async () => ({ ok: true, copied }) }; } });
const app = { reloadNodeDefs: async () => { reloads += 1; } };
assert.deepEqual(await copyExampleMedia({ nodes: [] }, api([]), app), []);
assert.equal(calls.length, 0, "no request without example files");
assert.deepEqual(await copyExampleMedia(workflow, api(["h3-example-hall.jpg"]), app), ["h3-example-hall.jpg"]);
assert.deepEqual(calls.at(-1), ["/ng/example_media", { names }]);
assert.equal(reloads, 1, "new files: the cards' file lists are reloaded");
await copyExampleMedia(workflow, api([]), app);
assert.equal(reloads, 1, "nothing copied: nothing reloaded");
const warn = console.warn;
console.warn = () => {};
assert.deepEqual(await copyExampleMedia(workflow, { fetchApi: async () => { throw new Error("offline"); } }, app), [], "a failed copy still opens the workflow");
console.warn = warn;
console.log("ng example media: copied on open, only what a workflow names, lists reloaded once");
