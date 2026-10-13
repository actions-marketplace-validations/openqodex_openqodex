# Clean controls: candidates to rule

Sheet clean@1@b112f7d4a795: 49 pull requests in a shuffled order (seed 1). A script found each merged, reviewed with no request for changes, and with no later fix, revert, fix-up or bug report it can see touching it; the evidence it read is under each. No reviewer has seen these changes. Read the change itself (the Files tab of its link) and rule whether it is free of any issue a reviewer should raise. Record each ruling under your own name:

```
node benchmark/queue.mjs decide clean <case id> --by <your name> --sheet clean@1@b112f7d4a795
node benchmark/queue.mjs decide not-clean <case id> --by <your name> --sheet clean@1@b112f7d4a795 --note "<the issue>"
node benchmark/ingest/clean.mjs admit
```

A ruling binds to this sheet's version of the candidates (b112f7d4a795) and to each candidate's evidence: if node benchmark/ingest/clean.mjs list writes them again with any change, admit refuses the ruling, and the sheet is printed and ruled again.

## 1. input: fix leaking tablet tool key name

- Case: clean/mpv-player__mpv-17610@d31234ab (evidence 391f9db4fb66)
- Change: https://github.com/mpv-player/mpv/pull/17610/files (13 changed lines in 1 file, C)
- Commits: base 5f9e1bc7bd2f48744c57c9055f50b7bf24f32356, head 884acb7b2e7bd559f36df6d7163f6ed50480cef5; merged 2026-03-19T19:45:55Z as https://github.com/mpv-player/mpv/commit/7b1ee864b83e6fe89f936f13b1c5ae34048432b9
- Licence: NOASSERTION, LICENSE.GPL (unverified: used and published in full)
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-17T19:45:55Z (read 2026-10-12): 8 later commits on its files, each read line by line (2 reading as a fix, revert or follow-up), none touching its lines
- Later commits on input/input.c:
  - 2026-04-06T16:28:04Z https://github.com/mpv-player/mpv/commit/b67a5b4cd84e7259abd3049620efb947abadda39 "input: fix out of bound read/write in pad_buttons_pressed": its changes miss the pull request's lines, which sit at 1137 to 1144 of its parent
  - 2026-04-06T16:28:04Z https://github.com/mpv-player/mpv/commit/e0fe1a45d2685cd2ec3d30c00064d51ac9d35225 "command: fix race in reading pad_buttons_pressed": its changes miss the pull request's lines, which sit at 1137 to 1144 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/5e0932e785c6e304ba762154b5f0d6a963df133b "input: rename mp_event_drop_files to mp_input_drop_files": its changes miss the pull request's lines, which sit at 1136 to 1143 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/544a56a14823b523c6c59d743ad2a81c2a2e3474 "input: rename notify_touch_update to notify_event_update": its changes miss the pull request's lines, which sit at 1138 to 1145 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/e12ab8457171f8c9da64bb57dfa2be2225a375b4 "input: add --input-builtin-drag-and-drop option": its changes miss the pull request's lines, which sit at 1138 to 1145 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/87ccb6022ca49a92663c09cbe5a682a555681bd7 "command: add dropped-file property": its changes miss the pull request's lines, which sit at 1141 to 1148 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/81611b4a4e267999618fa762eacd8614f36cea6b "input/dnd: move built-in drag and drop handling to mpv client": its changes miss the pull request's lines, which sit at 1147 to 1154 of its parent
  - 2026-06-09T09:52:29Z https://github.com/mpv-player/mpv/commit/a7d0ebaf7647542885ec39276bc99f23116bf862 "input: remove unused mp_input_src_feed_cmd_text()": its changes miss the pull request's lines, which sit at 1144 to 1151 of its parent
- Ruling: 

## 2. Update README.

- Case: clean/Comfy-Org__ComfyUI-12931@de258265 (evidence 85e73b3471bd)
- Change: https://github.com/Comfy-Org/ComfyUI/pull/12931/files (11 changed lines in 1 file, Python)
- Commits: base 7810f49702eac6e617eb7f2c30b00a8939ef1404, head 0f405efcc3d9267cfb9380c72de65abca9a8f736; merged 2026-03-14T02:33:28Z as https://github.com/Comfy-Org/ComfyUI/commit/16cd8d8a8f5f16ce7e5f929fdba9f783990254ea
- Licence: GPL-3.0, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-12T02:33:28Z (read 2026-10-12): 15 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on README.md:
  - 2026-03-30T02:07:38Z https://github.com/Comfy-Org/ComfyUI/commit/537c10d231cf691ada070fa98978a2ddadb064fc "Update README.md with latest AMD Linux pytorch. (#13228)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-03-31T03:11:02Z https://github.com/Comfy-Org/ComfyUI/commit/076639fed99742f43ffbf0b0df34bb8fd105b8e9 "Update README with note on model support (#13235)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-04-04T23:02:47Z https://github.com/Comfy-Org/ComfyUI/commit/13917b388028aee922efce6b4714db96e8cfea36 "Nightly Nvidia pytorch is now cu132 (#13288)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-04-05T23:37:27Z https://github.com/Comfy-Org/ComfyUI/commit/4b1444fc7a7d1dc542020f509dab2e2b90a4f16a "Update README.md with new frontend release cycle. (#13301)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-04-20T00:26:12Z https://github.com/Comfy-Org/ComfyUI/commit/fc5f4a996b9c752a716badbbc11bacc396281466 "Add link to Intel portable to Readme. (#13477)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-05-02T00:19:32Z https://github.com/Comfy-Org/ComfyUI/commit/67f6cb35273d00278d2b1ef2a8c3efe21238f22d "List all the portable downloads in the README section. (#13666)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-05-03T04:20:17Z https://github.com/Comfy-Org/ComfyUI/commit/f6d5068ac0163e7f626c9cec2e7c663cf6fa64a8 "Update README (#13679)": its changes miss the pull request's lines, which sit at 41 to 42, 54 to 60 of its parent
  - 2026-05-03T10:48:58Z https://github.com/Comfy-Org/ComfyUI/commit/d0f0b15cf5d1fbff67390c8d90ec8654c2582f7a "Update ComfyUI screenshot in README (#13683)": its changes miss the pull request's lines, which sit at 46 to 47, 59 to 65 of its parent
  - 2026-05-05T03:45:48Z https://github.com/Comfy-Org/ComfyUI/commit/9aef025fb0c67c9982e6ea52e7a866fd23625c5e "Document core release frequency is now ~2 weeks. (#13710)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
  - 2026-05-14T17:32:40Z https://github.com/Comfy-Org/ComfyUI/commit/3f9bdc70ee39f07894a2353abdb0926d9f31ce40 "Add careers link to README and startup log (#13897)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
  - 2026-05-17T03:55:43Z https://github.com/Comfy-Org/ComfyUI/commit/7c4d95d1bc2ef178937d203aa81070db0b172a92 "Enhance README with application and cloud links (#13936)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
  - 2026-05-22T02:52:38Z https://github.com/Comfy-Org/ComfyUI/commit/965057037818bc3ee24e034308c8a716f6654a65 "Update Discord invite link in README.md (#14045)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
  - 2026-05-24T02:48:31Z https://github.com/Comfy-Org/ComfyUI/commit/32a7092c52d2cee053fded50a6e12c7e275b195e "fix: correct description of where compiled FE files live (#14013)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
  - 2026-06-11T03:27:08Z https://github.com/Comfy-Org/ComfyUI/commit/33e6ebd0d92b270e9bd79ea74e967f7e23e7d7e8 "I don't think this actually works anymore. (#14403)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
  - 2026-06-11T22:45:22Z https://github.com/Comfy-Org/ComfyUI/commit/befc321438bd170b647ea1b4179b00b616858c9c "Make --enable-manager-legacy-ui imply --enable-manager (#14421)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
- Ruling: 

## 3. ci(gdb): fix yaml syntax and ci check failed

- Case: clean/lvgl__lvgl-9823@2041d240 (evidence d3760c77d45a)
- Change: https://github.com/lvgl/lvgl/pull/9823/files (6 changed lines in 2 files, C)
- Commits: base 8cbb234174a6432a31c3c0113daed28c17ae5874, head 71fce30863d2d381a217a75975283ff8eefde9ad; merged 2026-03-09T08:59:09Z as https://github.com/lvgl/lvgl/commit/2c888ecd32375fe493b90d68161339a0e61c7b5b
- Licence: MIT, LICENCE.txt
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-07T08:59:09Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 4. [Fix] handle PaddleOCR-VL image processor max_pixels across Transformers v4/v5

- Case: clean/vllm-project__vllm-38629@4c174ead (evidence 35bd258a1910)
- Change: https://github.com/vllm-project/vllm/pull/38629/files (8 changed lines in 1 file, Python)
- Commits: base 719735d6c5f5dae14948c2150e6858351994b0b9, head 5fb284979680b983472bafe07481bda7ca01c8c8; merged 2026-03-31T15:50:41Z as https://github.com/vllm-project/vllm/commit/b6e636c12c28c9ae83e22c65b4fca64a5571483b
- Licence: Apache-2.0, LICENSE
- Reviews by others: 5 (approved 1, commented 4); none requested changes
- Checked up to 2026-06-29T15:50:41Z (read 2026-10-12): 3 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on vllm/model_executor/models/paddleocr_vl.py:
  - 2026-04-16T13:14:00Z https://github.com/vllm-project/vllm/commit/4269b794091c057491b2ee5ac855d5a268959cb7 "[Model] Use mm_features to compute mrope positions for PaddleOCR-VL (#39888)": its changes miss the pull request's lines, which sit at 203 to 209 of its parent
  - 2026-05-11T09:04:06Z https://github.com/vllm-project/vllm/commit/9efdddca283cc0eb7c37fa49c4a9d1c9bf59ec4e "[Model] Fix missing `maybe_prefix` (#42280)": its changes miss the pull request's lines, which sit at 203 to 209 of its parent
  - 2026-06-05T12:19:04Z https://github.com/vllm-project/vllm/commit/62215e72c6ff4979009c27aa95f7449213007f8f "Remove KV cache scale boilerplate from model weight loading methods (#43167)": its changes miss the pull request's lines, which sit at 203 to 209 of its parent
- Ruling: 

## 5. [CI] Fix SPLADE pooler test broken by #38139

- Case: clean/vllm-project__vllm-38495@143f0776 (evidence da33b2b0d414)
- Change: https://github.com/vllm-project/vllm/pull/38495/files (12 changed lines in 1 file, Python)
- Commits: base 63babd17f1b110e267e1ad801a9b9d4ccf5bbe7d, head 332c7831eebdbad0d22a37133f36fa9055b7b692; merged 2026-03-30T07:48:34Z as https://github.com/vllm-project/vllm/commit/a08b7733fd3c07ad7b28e15a3fd3e75a503989ec
- Licence: Apache-2.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-28T07:48:34Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits naming it (quoting its title, or with no fix word): https://github.com/vllm-project/vllm/commit/b92312dfd75c754ed78604add44e5634998dc053 "[CI] Fix SPLADE pooler test broken by #38139 (#38495)"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/vllm-project/vllm/issues/38582 "[CI Failure]: tests/models/language/pooling/test_splade_sparse_pooler.py"
- Ruling: 

## 6. [4.x] Feat: add new tailwindcss colors

- Case: clean/filamentphp__filament-19304@4e85e247 (evidence 79187c3474ea)
- Change: https://github.com/filamentphp/filament/pull/19304/files (62 changed lines in 1 file, PHP)
- Commits: base cdcf753675f0675c239c76c018e44b9f61d2a46e, head 7a48ed0ea16167238758214161cf82afc8dd5f9b; merged 2026-02-28T18:14:20Z as https://github.com/filamentphp/filament/commit/4a1246512e552cec69f545118e4e35b87a5a6813
- Licence: MIT, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-29T18:14:20Z (read 2026-10-12): 2 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on packages/support/src/Colors/Color.php:
  - 2026-04-13T09:03:18Z https://github.com/filamentphp/filament/commit/aa82febcd584e02024a8fc3b053f71f58360d48a "Fix avatar background color of ui-avatars provider (#19664)": its changes miss the pull request's lines, which sit at 77 to 132, 445, 610 to 613 of its parent
  - 2026-05-01T09:28:09Z https://github.com/filamentphp/filament/commit/926db5727cc79eac162f0f7d4a7b95363ecba40f "task: Refactor color contrast resolution (#19774)": its changes miss the pull request's lines, which sit at 79 to 134, 447, 625 to 628 of its parent
- Ruling: 

## 7. Bayer node: fix web worker usage

- Case: clean/mrdoob__three.js-33279@695e9c4b (evidence aadf28806094)
- Change: https://github.com/mrdoob/three.js/pull/33279/files (15 changed lines in 1 file, JavaScript)
- Commits: base 2baf31e360d060220548713b3c577a92054bed25, head 1221ce88ac3f19482ff70655cc710cd648fa9239; merged 2026-03-30T09:08:41Z as https://github.com/mrdoob/three.js/commit/e13523a796b5cd4e4bcbb1fac9db96c410f05fd4
- Licence: MIT, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-28T09:08:41Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 8. middleware: enable local tool model for web search

- Case: clean/ollama__ollama-14787@99e6582b (evidence 417934138fa9)
- Change: https://github.com/ollama/ollama/pull/14787/files (62 changed lines in 2 files, Go)
- Commits: base c222735c02a3fda18cdbd05ccae2d5dc1a290b42, head a85b62db0a0a822faa9871a0b5cd1cc4a8f7fdf7; merged 2026-03-11T21:51:39Z as https://github.com/ollama/ollama/commit/8f45236d09332949aa91774dc9eb46caf2abbbc1
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-09T21:51:39Z (read 2026-10-12): 3 later commits on its files, each read line by line (2 reading as a fix, revert or follow-up), none touching its lines
- Later commits on middleware/anthropic.go:
  - 2026-03-13T21:50:49Z https://github.com/ollama/ollama/commit/abf8e8e9c81c00270876c250ad886dfc4a20c8b2 "middleware: handle non-JSON error responses gracefully (#14828)": its changes miss the pull request's lines, which sit at 242 to 243 of its parent
  - 2026-03-27T21:30:16Z https://github.com/ollama/ollama/commit/ac83ac20c444656f0f7d5bbad5b62da389395439 "anthropic: fix KV cache reuse degraded by tool call argument reordering": its changes miss the pull request's lines, which sit at 243 to 244 of its parent
- Later commits on middleware/anthropic_test.go:
  - 2026-03-27T21:30:16Z https://github.com/ollama/ollama/commit/ac83ac20c444656f0f7d5bbad5b62da389395439 "anthropic: fix KV cache reuse degraded by tool call argument reordering": its changes miss the pull request's lines, which sit at 1647 to 1675, 1716 to 1726, 1728 to 1729, 1731 to 1732 of its parent
- Ruling: 

## 9. Introduce the `save_and_drop` for `RootView`.

- Case: clean/linera-io__linera-protocol-5668@96d3beea (evidence b6beb6eddde2)
- Change: https://github.com/linera-io/linera-protocol/pull/5668/files (457 changed lines in 37 files, Rust)
- Commits: base b42b55403c7947251f852c9c15adb6ad49d6ee0f, head f67b26eaa6500eee88be5cd6b6d91bedabc2632c; merged 2026-03-12T09:31:44Z as https://github.com/linera-io/linera-protocol/commit/d2f11c3804ccf567f21726932226f966dc6224d8
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-10T09:31:44Z (read 2026-10-12): 11 later commits on its files, each read line by line (4 reading as a fix, revert or follow-up), none touching its lines
- Later commits on examples/controller/src/contract.rs:
  - 2026-05-08T18:05:21Z https://github.com/linera-io/linera-protocol/commit/c57ff5dbabedbd404a3f68764b465896c85399fc "[Frontport] Implement application introspection (#6264)": its changes miss the pull request's lines, which sit at 330 to 334 of its parent
- Later commits on examples/ethereum-tracker/src/contract.rs:
  - 2026-04-27T12:55:08Z https://github.com/linera-io/linera-protocol/commit/3a3b31cbb32a96806c71ef2b95859c3664a6d381 "Main clippy synchronization (#6134)": its changes miss the pull request's lines, which sit at 73 to 77 of its parent
- Later commits on examples/fungible/src/contract.rs:
  - 2026-03-20T20:43:10Z https://github.com/linera-io/linera-protocol/commit/103a7ce89b8c7c212330c2657d2bf906f5b20d0f "Backport Linera<>EVM bridge to main (#5670)": its changes miss the pull request's lines, which sit at 155 to 159 of its parent
- Later commits on examples/hex-game/src/contract.rs:
  - 2026-05-08T18:05:21Z https://github.com/linera-io/linera-protocol/commit/c57ff5dbabedbd404a3f68764b465896c85399fc "[Frontport] Implement application introspection (#6264)": its changes miss the pull request's lines, which sit at 100 to 104 of its parent
- Later commits on examples/social/src/contract.rs:
  - 2026-05-08T18:05:21Z https://github.com/linera-io/linera-protocol/commit/c57ff5dbabedbd404a3f68764b465896c85399fc "[Frontport] Implement application introspection (#6264)": its changes miss the pull request's lines, which sit at 106 to 110 of its parent
- Later commits on linera-sdk/tests/fixtures/create-and-call/src/contract.rs:
  - 2026-04-27T12:55:08Z https://github.com/linera-io/linera-protocol/commit/3a3b31cbb32a96806c71ef2b95859c3664a6d381 "Main clippy synchronization (#6134)": its changes miss the pull request's lines, which sit at 91 to 95 of its parent
  - 2026-05-08T18:05:21Z https://github.com/linera-io/linera-protocol/commit/c57ff5dbabedbd404a3f68764b465896c85399fc "[Frontport] Implement application introspection (#6264)": its changes miss the pull request's lines, which sit at 91 to 95 of its parent
- Later commits on linera-views-derive/src/lib.rs:
  - 2026-03-18T15:23:26Z https://github.com/linera-io/linera-protocol/commit/c6bffe64a7d0a9f261423495175b22193d236724 "Step 4 of clippy corrections (#5727)": its changes miss the pull request's lines, which sit at 300 to 308 of its parent
  - 2026-05-13T15:29:28Z https://github.com/linera-io/linera-protocol/commit/fe328ea4f3fbc6db38e7e6f0cac61be2ba44a761 "Deny `cast_*` lints; better handle overflows/underflows. (#6293)": its changes miss the pull request's lines, which sit at 299 to 307 of its parent
  - 2026-05-28T05:22:52Z https://github.com/linera-io/linera-protocol/commit/ff76007c3822818458e65f20003307fa6b528ba7 "Require docs on 6 more library crates with #![deny(missing_docs)] (#6402)": its changes miss the pull request's lines, which sit at 301 to 309 of its parent
- Later commits on linera-views/src/views/mod.rs:
  - 2026-04-15T08:20:24Z https://github.com/linera-io/linera-protocol/commit/a59eb56dde701e759359f01884d073dd655d0a22 "Introduce the `LazyRegisterView` and make it work with `description`, `application_permissions` and `ownership`. (#5996)": its changes miss the pull request's lines, which sit at 179 to 181 of its parent
- Ruling: 

## 10. BIM: baseless ArchComponent should not lose shape

- Case: clean/FreeCAD__FreeCAD-28742@ff452fa9 (evidence ecfd64f4b22a)
- Change: https://github.com/FreeCAD/FreeCAD/pull/28742/files (45 changed lines in 2 files, C++)
- Commits: base ffb07e2f1a51029697aaac024214e26c6112b48e, head e56c8fb831fe53757972637488b65aeb6f3f3cfc; merged 2026-03-30T16:37:27Z as https://github.com/FreeCAD/FreeCAD/commit/c1668389ed1eeec3525df5e1a263b7071b7581fb
- Licence: LGPL-2.1, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T16:37:27Z (read 2026-10-12): 6 later commits on its files, each read line by line (2 reading as a fix, revert or follow-up), none touching its lines
- Later commits on src/Mod/BIM/ArchComponent.py:
  - 2026-04-12T18:52:41Z https://github.com/FreeCAD/FreeCAD/commit/77125665398810c8e23d1ecadff8ec7a3fdadaf8 "BIM: fix Material property pulling into Part container (#28358) (#29262)": its changes miss the pull request's lines, which sit at 378 to 379, 382 to 383, 400 of its parent
  - 2026-05-15T01:04:05Z https://github.com/FreeCAD/FreeCAD/commit/0f9e316e1bb4d5cd469594b1c14d94c4373390e9 "BIM: skip element maps for horizontal area geometry": its changes miss the pull request's lines, which sit at 390 to 391, 394 to 395, 412 of its parent
  - 2026-05-26T17:25:08Z https://github.com/FreeCAD/FreeCAD/commit/26ca5b4bda657d359a783e9de99d7ae0a07fc513 "BIM: add MoveBase handling to getMovableChildren": its changes miss the pull request's lines, which sit at 402 to 403, 406 to 407, 424 of its parent
  - 2026-05-27T14:41:58Z https://github.com/FreeCAD/FreeCAD/commit/dee977f98f8a8542c8db0be2ecc529a771931d01 "Clean up missed strings acc. to FEP007": its changes miss the pull request's lines, which sit at 402 to 403, 406 to 407, 424 of its parent
  - 2026-05-31T07:18:28Z https://github.com/FreeCAD/FreeCAD/commit/dda08980055fa9e1a0dcc30da7e8757c47fc73f8 "BIM: fix faulty Presets paths (#29913)": its changes miss the pull request's lines, which sit at 402 to 403, 406 to 407, 424 of its parent
- Later commits on src/Mod/BIM/bimtests/TestArchComponent.py:
  - 2026-05-15T01:04:05Z https://github.com/FreeCAD/FreeCAD/commit/0f9e316e1bb4d5cd469594b1c14d94c4373390e9 "BIM: skip element maps for horizontal area geometry": its changes miss the pull request's lines, which sit at 704 to 706, 708 to 709, 711 to 712, 714 to 716, 718, 721 to 732 of its parent
- Later commits naming it (quoting its title, or with no fix word): https://github.com/FreeCAD/FreeCAD/commit/8ebeb55ec11ccf71ac8c2d3a2f07ef1956c5db51 "[Backport releases/FreeCAD-1-1] BIM: baseless ArchComponent should not lose shape (#28895)"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/FreeCAD/FreeCAD/pull/28895 "[Backport releases/FreeCAD-1-1] BIM: baseless ArchComponent should not lose shape"
- Ruling: 

## 11. Fix race in snapshotFSBuilder.FileExists()

- Case: clean/microsoft__typescript-go-3153@83f3e0e2 (evidence b78fffed1380)
- Change: https://github.com/microsoft/typescript-go/pull/3153/files (7 changed lines in 1 file, Go)
- Commits: base 4e4915cc56e954e4e1bf8d14c66cd81104153b73, head c5719aafc73f4b0944f3abb2a44d51469247a38a; merged 2026-03-18T22:27:24Z as https://github.com/microsoft/typescript-go/commit/d7a2186582eeeb4554e6b0dc56987dfbdba041b3
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-16T22:27:24Z (read 2026-10-12): 4 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on internal/project/snapshotfs.go:
  - 2026-04-14T21:19:25Z https://github.com/microsoft/typescript-go/commit/e63879fd9d6d807e140641c4115170c92ed72a08 "Fix watching files outside the workspace and realpaths symlinked into programs (#3395)": its changes miss the pull request's lines, which sit at 253, 256 of its parent
  - 2026-04-21T22:37:29Z https://github.com/microsoft/typescript-go/commit/21b262e07ea53836f63b3b78254949a5bcb49b83 "Mark file as changed when didOpen content differs from disk content (#3483)": its changes miss the pull request's lines, which sit at 307, 310 of its parent
  - 2026-04-24T20:43:33Z https://github.com/microsoft/typescript-go/commit/7abf963545d634598f1a047d820f34215620b8de "adds tracing (--generateTrace) (#2914)": its changes miss the pull request's lines, which sit at 307, 310 of its parent
  - 2026-06-15T16:32:41Z https://github.com/microsoft/typescript-go/commit/f315ef97b58466259379254b179572671d586d03 "Ensure node_modules buckets are removed from auto-import registry once they no longer exist (#4303)": its changes miss the pull request's lines, which sit at 307, 310 of its parent
- Ruling: 

## 12. stats.lua: display more info on page 5

- Case: clean/mpv-player__mpv-17434@7bc9ed2d (evidence 4cfcaf987c21)
- Change: https://github.com/mpv-player/mpv/pull/17434/files (48 changed lines in 9 files, C)
- Commits: base 250d6056c3ebef4c47dbc789e6fbe0ffc3f724c1, head 32fe7425f10954e7f32efb0f2bd4caefd035e754; merged 2026-02-24T18:36:33Z as https://github.com/mpv-player/mpv/commit/3eb8f9a1de70f03c4ef2b1c6ec0cecb81f84c103
- Licence: NOASSERTION, LICENSE.GPL (unverified: used and published in full)
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-05-25T18:36:33Z (read 2026-10-12): 77 later commits on its files, each read line by line (15 reading as a fix, revert or follow-up), none touching its lines
- Later commits on DOCS/man/input.rst:
  - 2026-02-27T08:21:14Z https://github.com/mpv-player/mpv/commit/3b555c349c245e0422df20bdeef6a440e41db42e "command: let playlist-play-index current preserve file-local-options": its changes miss the pull request's lines, which sit at 3511, 3519 to 3521 of its parent
  - 2026-03-08T12:07:05Z https://github.com/mpv-player/mpv/commit/ba30c8c1750c96a3a39150c9f729342867eb161a "player/loadfile: add on_loaded hook": its changes miss the pull request's lines, which sit at 3514, 3522 to 3524 of its parent
  - 2026-03-08T12:07:37Z https://github.com/mpv-player/mpv/commit/937e67e7b17f50a5a8bee8f2627914ada2dec48a "DOCS/man/input: fix typo": its changes miss the pull request's lines, which sit at 3521, 3529 to 3531 of its parent
  - 2026-03-08T17:02:01Z https://github.com/mpv-player/mpv/commit/147c951a1735e9164d8e862e081792631f7d27f8 "DOCS/man/input: add tablet-pos node map schema": its changes miss the pull request's lines, which sit at 3521, 3529 to 3531 of its parent
  - 2026-03-12T14:58:53Z https://github.com/mpv-player/mpv/commit/3cd66d2fd7ee892c623d0d353b4319b3c4db895f "command: avoid crashing the player with mmap": its changes miss the pull request's lines, which sit at 3535, 3543 to 3545 of its parent
  - 2026-03-21T15:05:36Z https://github.com/mpv-player/mpv/commit/f7f7cf18f3043e2e7cb3d2790ad8eff4c981d372 "command: add update-clipboard command": its changes miss the pull request's lines, which sit at 3540, 3548 to 3550 of its parent
  - 2026-03-30T15:09:38Z https://github.com/mpv-player/mpv/commit/9465b30a404dd2f713c6ef515c029ce4d26ebdc9 "DOCS: remove behavior changes before version 0.38": its changes miss the pull request's lines, which sit at 3556, 3564 to 3566 of its parent
  - 2026-03-31T18:44:10Z https://github.com/mpv-player/mpv/commit/5f45db9d708fe74286966d5df82f9d4775d07008 "DOCS/man/input: document dummy properties": its changes miss the pull request's lines, which sit at 3537, 3545 to 3547 of its parent
  - 2026-03-31T18:44:10Z https://github.com/mpv-player/mpv/commit/d79c4ad1e33301552e23c9bb98ec3c6c9a4324b9 "player/command: add env property": its changes miss the pull request's lines, which sit at 3537, 3545 to 3547 of its parent
  - 2026-04-01T14:08:26Z https://github.com/mpv-player/mpv/commit/ae2384bce0e8dc55b1f8892e85f330aa872aaa7a "player/command: add default-value/choices arg fields to command-list": its changes miss the pull request's lines, which sit at 3541, 3549 to 3551 of its parent
  - 2026-04-01T22:09:25Z https://github.com/mpv-player/mpv/commit/70b8b22c8bfd45fd68c61d890e68d1ab88e24d5d "command: remove the deprecated time-start property": its changes miss the pull request's lines, which sit at 3541, 3549 to 3551 of its parent
  - 2026-04-01T22:10:08Z https://github.com/mpv-player/mpv/commit/c961c96afb83d485d57ffa82106cf7e9882e1e59 "lua: remove the deprecated error field from end-file": its changes miss the pull request's lines, which sit at 3536, 3544 to 3546 of its parent
  - 2026-04-06T16:33:20Z https://github.com/mpv-player/mpv/commit/80582efca511fa2db80fe5f830e5c29163c3f81c "input/cmd: use _name for command name in mpv_command_node": its changes miss the pull request's lines, which sit at 3532, 3540 to 3542 of its parent
  - 2026-04-06T16:33:20Z https://github.com/mpv-player/mpv/commit/dbd31fd9d3aecd753d0dedbe8fefbaab6328dddd "DOCS/man: use _name key for mp.command_native": its changes miss the pull request's lines, which sit at 3532, 3540 to 3542 of its parent
  - 2026-04-08T18:24:07Z https://github.com/mpv-player/mpv/commit/1bfa18107c5596cd86bd6166c994a972656c4118 "DOCS/man/input: add note on env case-sensitivity": its changes miss the pull request's lines, which sit at 3532, 3540 to 3542 of its parent
  - 2026-04-17T16:30:43Z https://github.com/mpv-player/mpv/commit/6c165fe46e39c0e13c8be79ba0c93c5a7f220d0e "demux_lavf: add support for programs": its changes miss the pull request's lines, which sit at 3537, 3545 to 3547 of its parent
  - 2026-04-17T16:30:43Z https://github.com/mpv-player/mpv/commit/cc9610b85017f336065ee1e8e469c5b1804b6762 "demux_timeline: add support for programs": its changes miss the pull request's lines, which sit at 3543, 3551 to 3553 of its parent
  - 2026-04-17T17:46:12Z https://github.com/mpv-player/mpv/commit/aec426a4d87703292cc9ba7d00bc84c7399d3257 "context_menu.lua: set user-data/mpv/context-menu/open": its changes miss the pull request's lines, which sit at 3543, 3551 to 3553 of its parent
  - 2026-04-17T18:36:48Z https://github.com/mpv-player/mpv/commit/09d075f475e60f3e9c8f88111bbc9fdb53b8cee6 "osc: define and add support for "preview" api": its changes miss the pull request's lines, which sit at 3543, 3551 to 3553 of its parent
  - 2026-04-18T03:37:38Z https://github.com/mpv-player/mpv/commit/d0df98f701b62d88e23d8afd50df7c835d91d746 "command: allow metadata to be set manually": its changes miss the pull request's lines, which sit at 3543, 3551 to 3553 of its parent
  - 2026-04-18T19:13:46Z https://github.com/mpv-player/mpv/commit/891273055fd8125c7455addac5fe0736ff5fdc80 "DOCS/man/input: fix mouse-pos/hover documentation": its changes miss the pull request's lines, which sit at 3543, 3551 to 3553 of its parent
  - 2026-04-25T17:58:52Z https://github.com/mpv-player/mpv/commit/5f02e1b8a21b5323adb643758409506ef0d2bbb6 "sub: add sub-lines property": its changes miss the pull request's lines, which sit at 3550, 3558 to 3560 of its parent
  - 2026-05-01T09:41:31Z https://github.com/mpv-player/mpv/commit/f5857d3b87c6377629c576cc78f2f2274ad18c14 "demux_lavf: support multiple program mappings per stream": its changes miss the pull request's lines, which sit at 3573, 3581 to 3583 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/87ccb6022ca49a92663c09cbe5a682a555681bd7 "command: add dropped-file property": its changes miss the pull request's lines, which sit at 3579, 3587 to 3589 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/81611b4a4e267999618fa762eacd8614f36cea6b "input/dnd: move built-in drag and drop handling to mpv client": its changes miss the pull request's lines, which sit at 3612, 3620 to 3622 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/675fb1229b25c64ebbb90e16ce9f3d1c30fb9750 "input/dnd: move --drag-and-drop handling to dnd client": its changes miss the pull request's lines, which sit at 3611, 3619 to 3621 of its parent
  - 2026-05-09T13:01:09Z https://github.com/mpv-player/mpv/commit/ed2e55b94118cb8831781e7cff636dc010be6a57 "options: make player-operation-mode readable as a property": its changes miss the pull request's lines, which sit at 3611, 3619 to 3621 of its parent
  - 2026-05-18T14:47:14Z https://github.com/mpv-player/mpv/commit/35ae76daad738ac31621c8c7f56300d7e99d1c43 "docs/comments: fix more doubled-word typos": its changes miss the pull request's lines, which sit at 3611, 3619 to 3621 of its parent
- Later commits on common/av_common.c:
  - 2026-04-17T02:09:23Z https://github.com/mpv-player/mpv/commit/da2739f44f018c501f7840ea5c3e3a616e2b10dd "various: don't check if endptr is null for strto[udll]": its changes miss the pull request's lines, which sit at 424 to 439 of its parent
- Later commits on demux/demux_lavf.c:
  - 2026-03-23T12:29:59Z https://github.com/mpv-player/mpv/commit/9339a68dfb078985bab6e779d741c62067972a57 "demux_lavf: mark packets with keyframe for wrapped avframes too": its changes miss the pull request's lines, which sit at 746, 823, 830 of its parent
  - 2026-04-17T02:09:23Z https://github.com/mpv-player/mpv/commit/da2739f44f018c501f7840ea5c3e3a616e2b10dd "various: don't check if endptr is null for strto[udll]": its changes miss the pull request's lines, which sit at 746, 823, 830 of its parent
  - 2026-04-17T16:30:43Z https://github.com/mpv-player/mpv/commit/6c165fe46e39c0e13c8be79ba0c93c5a7f220d0e "demux_lavf: add support for programs": its changes miss the pull request's lines, which sit at 746, 823, 830 of its parent
  - 2026-04-29T01:45:05Z https://github.com/mpv-player/mpv/commit/91b6d8fdd12401c5e06d9864db0ee9d502c51ee6 "demux: enrich edition titles with codec/resolution/bitrate info": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-04-29T17:23:42Z https://github.com/mpv-player/mpv/commit/5ebe9581d522d6592bcd664c331227e11d5d9f02 "demux_{lavf,timeline}: consider audio only HLS when selecting edition": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-01T04:09:27Z https://github.com/mpv-player/mpv/commit/ec03ef7e9730582ace5698bd27393cefa50d5862 "demux_lavf: remove track flags duplication from title": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-01T04:09:27Z https://github.com/mpv-player/mpv/commit/8aef2c9162eb192c86d8e69d708d7db301c729e6 "demux_lavf: map `comment` to stream title": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-01T08:42:00Z https://github.com/mpv-player/mpv/commit/b4a7ea306e4f3e311060c5aacec7a81140d71f1f "demux_{lavf,timeline}: add `--flatten-editions`": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-01T09:41:31Z https://github.com/mpv-player/mpv/commit/f5857d3b87c6377629c576cc78f2f2274ad18c14 "demux_lavf: support multiple program mappings per stream": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-01T09:44:26Z https://github.com/mpv-player/mpv/commit/cdbe01c3db570bb5ceacbfdd462a3a80e78435a6 "demux_lavf: add support for stream groups": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-13T12:55:48Z https://github.com/mpv-player/mpv/commit/aa57714b633494fd29e3077e2b95baaf44bb7c31 "video: merge the tiles of grid heif and avif images": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
  - 2026-05-16T16:20:42Z https://github.com/mpv-player/mpv/commit/b14d8f5ee1eaf9bf96fbf43df91b4d0a481e68a6 "demux_lavf: route nested HTTP opens through the curl backend": its changes miss the pull request's lines, which sit at 747, 824, 831 of its parent
- Later commits on demux/stheader.h:
  - 2026-05-01T09:41:31Z https://github.com/mpv-player/mpv/commit/f5857d3b87c6377629c576cc78f2f2274ad18c14 "demux_lavf: support multiple program mappings per stream": its changes miss the pull request's lines, which sit at 111 to 112, 135, 140 to 142 of its parent
  - 2026-05-13T12:02:10Z https://github.com/mpv-player/mpv/commit/1095d85b51f9614991e1e4cf88d61b293d4ac29d "demux/stheader: add sh_stream_group representing stream group": its changes miss the pull request's lines, which sit at 122 to 123, 146, 151 to 153 of its parent
- Later commits on player/command.c:
  - 2026-02-27T08:21:14Z https://github.com/mpv-player/mpv/commit/3b555c349c245e0422df20bdeef6a440e41db42e "command: let playlist-play-index current preserve file-local-options": its changes miss the pull request's lines, which sit at 2095 of its parent
  - 2026-02-27T19:18:42Z https://github.com/mpv-player/mpv/commit/e54cee1b23db7e38d84314c4ac719e55b589afdb "player/command: apply `expand-properties` modifier also for string lists": its changes miss the pull request's lines, which sit at 2095 of its parent
  - 2026-03-03T02:06:39Z https://github.com/mpv-player/mpv/commit/c401ef9c3b005deb24afec1d0b5d1cb4cea72d14 "screenshot: use mp_strip_ext for %F": its changes miss the pull request's lines, which sit at 2095 of its parent
  - 2026-03-09T14:43:32Z https://github.com/mpv-player/mpv/commit/07c3ff3725ee7221fe9d8da396877d47734f78f6 "command: reject negative offset for overlay-add": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-03-10T07:56:23Z https://github.com/mpv-player/mpv/commit/3ff7b0479012681805933a808a2d35053c905aa6 "player/command: don't send mouse move event on mouse leave request": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-03-12T14:58:53Z https://github.com/mpv-player/mpv/commit/3cd66d2fd7ee892c623d0d353b4319b3c4db895f "command: avoid crashing the player with mmap": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-03-15T13:49:00Z https://github.com/mpv-player/mpv/commit/8ace278cbea63f74863d242a991474e12fab3730 "various: fix `Wdiscarded-qualifiers` warnings": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-03-15T17:40:09Z https://github.com/mpv-player/mpv/commit/022fbd16b99187d51f1961da788c2720cf3036ec "meson: bump min libplacebo version to v7.360.1": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-03-21T15:05:36Z https://github.com/mpv-player/mpv/commit/f7f7cf18f3043e2e7cb3d2790ad8eff4c981d372 "command: add update-clipboard command": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-03-31T18:44:10Z https://github.com/mpv-player/mpv/commit/d79c4ad1e33301552e23c9bb98ec3c6c9a4324b9 "player/command: add env property": its changes miss the pull request's lines, which sit at 2093 of its parent
  - 2026-04-01T14:08:26Z https://github.com/mpv-player/mpv/commit/ae2384bce0e8dc55b1f8892e85f330aa872aaa7a "player/command: add default-value/choices arg fields to command-list": its changes miss the pull request's lines, which sit at 2125 of its parent
  - 2026-04-01T22:05:27Z https://github.com/mpv-player/mpv/commit/4e6196e1a627c5becd3d1e831bd3d3aa6541e972 "player/command: fix update-clipboard text-primary": its changes miss the pull request's lines, which sit at 2125 of its parent
  - 2026-04-01T22:09:25Z https://github.com/mpv-player/mpv/commit/70b8b22c8bfd45fd68c61d890e68d1ab88e24d5d "command: remove the deprecated time-start property": its changes miss the pull request's lines, which sit at 2125 of its parent
  - 2026-04-06T16:26:34Z https://github.com/mpv-player/mpv/commit/7f28b8818ae46eea29461b0e15b321f5c8e475b3 "player/command: use m_property_read_sub for mouse-pos": its changes miss the pull request's lines, which sit at 2118 of its parent
  - 2026-04-06T16:26:34Z https://github.com/mpv-player/mpv/commit/629205280c75267965f66e2d974166874e5d616a "player/command: rename to mp_property_list_editions": its changes miss the pull request's lines, which sit at 2118 of its parent
  - 2026-04-06T16:26:34Z https://github.com/mpv-player/mpv/commit/cf957b4f2a02fc1df576967f3f86842d286c5302 "player/command: use m_property_read_sub_validate when suitable": its changes miss the pull request's lines, which sit at 2118 of its parent
  - 2026-04-06T16:28:04Z https://github.com/mpv-player/mpv/commit/e0fe1a45d2685cd2ec3d30c00064d51ac9d35225 "command: fix race in reading pad_buttons_pressed": its changes miss the pull request's lines, which sit at 2132 of its parent
  - 2026-04-17T16:30:43Z https://github.com/mpv-player/mpv/commit/85bdf63a484360e4d53a2c719f4c82553352cb0d "player/command: simplify and fix new-line handling": its changes miss the pull request's lines, which sit at 2132 of its parent
  - 2026-04-17T16:30:43Z https://github.com/mpv-player/mpv/commit/6c165fe46e39c0e13c8be79ba0c93c5a7f220d0e "demux_lavf: add support for programs": its changes miss the pull request's lines, which sit at 2132 of its parent
  - 2026-04-18T03:37:38Z https://github.com/mpv-player/mpv/commit/d0df98f701b62d88e23d8afd50df7c835d91d746 "command: allow metadata to be set manually": its changes miss the pull request's lines, which sit at 2143 of its parent
  - 2026-04-18T15:45:03Z https://github.com/mpv-player/mpv/commit/8f66c0982fc14ac38acd8b11294c205f4cc6e834 "command: log menu-data changes at trace level instead of verbose": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-04-18T19:13:46Z https://github.com/mpv-player/mpv/commit/bceb1eeaf49eb98d208a97e1308804f91ef7a6f1 "Revert "player/command: don't send mouse move event on mouse leave request"": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-04-18T19:13:46Z https://github.com/mpv-player/mpv/commit/25e9a0c7400653c84e782fe1a21409c4ab450705 "player/command: remove inaccurate comment in cmd_mouse": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-04-25T05:15:37Z https://github.com/mpv-player/mpv/commit/99b9d9491d363c4209d44cc671221c3f5888a1bd "player/command: add more precision to av speed correction pretty print": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-04-25T05:15:37Z https://github.com/mpv-player/mpv/commit/382e3e74e813bff68614068b891d7a26a0c84801 "player/command: add more precision to avsync pretty print": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-04-25T17:58:52Z https://github.com/mpv-player/mpv/commit/5f02e1b8a21b5323adb643758409506ef0d2bbb6 "sub: add sub-lines property": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-05-01T08:42:00Z https://github.com/mpv-player/mpv/commit/eedadc24ae274aa20fad28564fbf675c9c7c89a8 "player/command: hide dependent tracks": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-05-01T09:41:31Z https://github.com/mpv-player/mpv/commit/f5857d3b87c6377629c576cc78f2f2274ad18c14 "demux_lavf: support multiple program mappings per stream": its changes miss the pull request's lines, which sit at 2147 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/41fb7f9eb284c55f1648c7b14cfc2f78a012e5be "command: use string list helper for option-info": its changes miss the pull request's lines, which sit at 2152 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/87ccb6022ca49a92663c09cbe5a682a555681bd7 "command: add dropped-file property": its changes miss the pull request's lines, which sit at 2152 of its parent
  - 2026-05-01T11:42:57Z https://github.com/mpv-player/mpv/commit/0ec3015339b0f5ba9404fb3d688e983ab3f3530b "player/external_files: remove handling related to update sub exts": its changes miss the pull request's lines, which sit at 2152 of its parent
  - 2026-05-09T13:01:09Z https://github.com/mpv-player/mpv/commit/ed2e55b94118cb8831781e7cff636dc010be6a57 "options: make player-operation-mode readable as a property": its changes miss the pull request's lines, which sit at 2152 of its parent
  - 2026-05-20T21:21:49Z https://github.com/mpv-player/mpv/commit/6eaf35866c329de33569f5e38cb5c403990f450e "command: add support for printing sub-lines": its changes miss the pull request's lines, which sit at 2152 of its parent
- Later commits on player/lua/stats.lua:
  - 2026-02-24T19:12:57Z https://github.com/mpv-player/mpv/commit/de0f2f943d485ad6623629831e079a1de8be021b "stats.lua: correctly override mp.input keybinds": its changes miss the pull request's lines, which sit at 38, 684, 1265, 1288, 1332, 1476 of its parent
- Ruling: 

## 13. fix(graph): class bug in serialization

- Case: clean/alibaba__spring-ai-alibaba-3969@38476032 (evidence 8bdb759eaec0)
- Change: https://github.com/alibaba/spring-ai-alibaba/pull/3969/files (736 changed lines in 6 files, Java)
- Commits: base 7a73cb0d437d44b363767eb3a0b5ea8adbfe1ae3, head 643de4ca4ea1eb7fffd700b5a003449ba6876af7; merged 2026-01-08T03:19:15Z as https://github.com/alibaba/spring-ai-alibaba/commit/4186368f3dfdf058f1142f377732c40ad2d41eec
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-04-08T03:19:15Z (read 2026-10-12): 1 later commit on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/serializer/plain_text/jackson/JacksonDeserializer.java:
  - 2026-01-22T09:08:19Z https://github.com/alibaba/spring-ai-alibaba/commit/13b1e22d18a7c16ffbe31e34cd9b7a49750b6000 "fix(graph): java.lang Serialization failed (#4111)": its changes miss the pull request's lines, which sit at 100 to 104, 322 to 326, 471 to 475 of its parent
- Ruling: 

## 14. fix tunnel process kill and daemon spawn on windows

- Case: clean/browser-use__browser-use-4530@8e204eb1 (evidence 404ecc8a7c41)
- Change: https://github.com/browser-use/browser-use/pull/4530/files (58 changed lines in 1 file, Python)
- Commits: base 86d33635c592e5dea6f8513e76cf932d4e4120fb, head 4950c3baa1638acc7efccadda1ea87eec77eb338; merged 2026-03-25T23:34:17Z as https://github.com/browser-use/browser-use/commit/6ce58afbc3f10d2184c34c2fc221f06592b46136
- Licence: MIT, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-23T23:34:17Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on browser_use/skill_cli/tunnel.py:
  - 2026-04-02T00:56:39Z https://github.com/browser-use/browser-use/commit/e09f55eedc7c3f79ca2deec7efbd26f23de52517 "chore: remove more dead code (second codex pass)": its changes miss the pull request's lines, which sit at 10, 21 to 22, 162 to 191, 228, 230 to 235, 243 of its parent
- Ruling: 

## 15. perf(server): optimize people page query

- Case: clean/immich-app__immich-27346@3fd9fbbd (evidence 8e860651c12f)
- Change: https://github.com/immich-app/immich/pull/27346/files (4 changed lines in 2 files, TypeScript)
- Commits: base eb20b715e4bb6c6668890f3b79fff6f541987d93, head 7434d1c2cdf77a77c213d497abdd2ee3323ed591; merged 2026-03-28T21:33:05Z as https://github.com/immich-app/immich/commit/b09ebb11e9cf49eb236f5fdabfe897302cf39c31
- Licence: AGPL-3.0, LICENSE
- Reviews by others: 4 (approved 2, commented 2); none requested changes
- Checked up to 2026-06-26T21:33:05Z (read 2026-10-12): 9 later commits on its files, each read line by line (8 reading as a fix, revert or follow-up), none touching its lines
- Later commits on server/src/queries/person.repository.sql:
  - 2026-04-01T12:19:38Z https://github.com/immich-app/immich/commit/c29493e3a0bd0a629648fe6cd7c72887d264b931 "fix: withFilePath select edited or unedited file (#27328)": its changes miss the pull request's lines, which sit at 230 to 231, 236 of its parent
  - 2026-04-01T13:31:54Z https://github.com/immich-app/immich/commit/d1e2e8ab4e9b01951ecc38c664a392cb0d51a7b5 "fix(server): use substring matching for person name search (#26903)": its changes miss the pull request's lines, which sit at 230 to 231, 236 of its parent
  - 2026-04-09T00:56:07Z https://github.com/immich-app/immich/commit/8d67c1f820aaec8d52ce8c1eb04a15ff0c4d81d9 "fix(server): people search not showing for 3 or less characters (#27629)": its changes miss the pull request's lines, which sit at 227 to 228, 233 of its parent
  - 2026-06-02T16:05:55Z https://github.com/immich-app/immich/commit/368cb7a4ad90f8cc9abd8c0975bf9092bd36c06b "feat: minimum face count per user (#27452)": its changes miss the pull request's lines, which sit at 233 to 234, 239 of its parent
- Later commits on server/src/repositories/person.repository.ts:
  - 2026-04-01T12:19:38Z https://github.com/immich-app/immich/commit/c29493e3a0bd0a629648fe6cd7c72887d264b931 "fix: withFilePath select edited or unedited file (#27328)": its changes miss the pull request's lines, which sit at 354 to 355, 361 of its parent
  - 2026-04-01T13:31:54Z https://github.com/immich-app/immich/commit/d1e2e8ab4e9b01951ecc38c664a392cb0d51a7b5 "fix(server): use substring matching for person name search (#26903)": its changes miss the pull request's lines, which sit at 346 to 347, 353 of its parent
  - 2026-04-09T00:56:07Z https://github.com/immich-app/immich/commit/8d67c1f820aaec8d52ce8c1eb04a15ff0c4d81d9 "fix(server): people search not showing for 3 or less characters (#27629)": its changes miss the pull request's lines, which sit at 340 to 341, 347 of its parent
  - 2026-04-22T14:52:23Z https://github.com/immich-app/immich/commit/4bfb8b36c25f585785e7fb1d8d26825080f751bb "chore!: migrate album owner to album_user (#27467)": its changes miss the pull request's lines, which sit at 343 to 344, 350 of its parent
  - 2026-06-02T16:05:55Z https://github.com/immich-app/immich/commit/368cb7a4ad90f8cc9abd8c0975bf9092bd36c06b "feat: minimum face count per user (#27452)": its changes miss the pull request's lines, which sit at 343 to 344, 350 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/claytono/infra/pull/2048 "Update immich monorepo to v2.7.5"
- Ruling: 

## 16. test: add missing unit tests for HTTP request (HostName, PathParam, body, Bind)

- Case: clean/gofr-dev__gofr-3221@2fce3575 (evidence c165b5c228b8)
- Change: https://github.com/gofr-dev/gofr/pull/3221/files (84 changed lines in 1 file, Go)
- Commits: base 20a401d52df6f90647ac309c06b53d2bb29ea977, head fc6859edf13ba9907a8ede02409caca815302aa7; merged 2026-03-30T18:31:41Z as https://github.com/gofr-dev/gofr/commit/8ec5abf83bedd3b650422c008282aa9f41ec52a7
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T18:31:41Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 17. feat(a2a): support multi-agent registration in single application

- Case: clean/alibaba__spring-ai-alibaba-4419@f0686e50 (evidence 44dd1c190b1b)
- Change: https://github.com/alibaba/spring-ai-alibaba/pull/4419/files (885 changed lines in 14 files, Java)
- Commits: base f62f943c6c579b7c38ab088ffada54ec4dab72de, head ad86b2f69b5d0644ee7990647fb03e149275ca73; merged 2026-03-14T09:02:30Z as https://github.com/alibaba/spring-ai-alibaba/commit/99c8d3fcc1270f5d44104659d03d149af8eb8bbb
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-12T09:02:30Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 18. fix: correct OAuth service health check URL

- Case: clean/gofr-dev__gofr-3185@0a6faa23 (evidence 5dc10b71a0e6)
- Change: https://github.com/gofr-dev/gofr/pull/3185/files (107 changed lines in 2 files, Go)
- Commits: base 01a7e62bd5a153ab82117807630cbbd63200116e, head 724bc995142ca2fc4c0096ec7bdb207eb6f4c0f6; merged 2026-03-24T07:08:11Z as https://github.com/gofr-dev/gofr/commit/a6f8a9d8ad6182e3cd6082be10d086a218ff13e4
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-22T07:08:11Z (read 2026-10-12): 5 later commits on its files, each read line by line (2 reading as a fix, revert or follow-up), none touching its lines
- Later commits on pkg/gofr/gofr_test.go:
  - 2026-04-03T07:52:55Z https://github.com/gofr-dev/gofr/commit/93c8dd6244e29248a004deb6539af7a1699763eb "fix: close file logger on shutdown and add verification test": its changes miss the pull request's lines, which sit at 424 to 502 of its parent
  - 2026-04-10T14:40:31Z https://github.com/gofr-dev/gofr/commit/5fe0011b9132270e8c3f94db1ddff03aa631984c "refactor: ensure safe cron shutdown using sync.Once and reorder application shutdown sequence": its changes miss the pull request's lines, which sit at 458 to 536 of its parent
  - 2026-04-20T06:27:31Z https://github.com/gofr-dev/gofr/commit/3aec255ca422ab6576e7ea9c937e0fd400df03d6 "Merge pull request #3296 from NitinKumar004/test/improve-core-coverage": its changes miss the pull request's lines, which sit at 458 to 536 of its parent
  - 2026-05-06T07:12:50Z https://github.com/gofr-dev/gofr/commit/ca648c233960bc7ad194f54a206107662ec2b88a "Merge branch 'development' into fix/crontab-goroutine-leak": its changes miss the pull request's lines, which sit at 458 to 536 of its parent
  - 2026-05-21T12:01:22Z https://github.com/gofr-dev/gofr/commit/6950b5f20277e0f0e6dadaea0342f73fee95a81b "perf: HTTP hot-path optimizations - alloc/CPU reductions in middleware, router, OTel setup (#3431)": its changes miss the pull request's lines, which sit at 460 to 538 of its parent
- Ruling: 

## 19. Fix crash on invalid `format_regexp` in `Regexp` format

- Case: clean/ClickHouse__ClickHouse-101074@efd27989 (evidence 4eb3aa16ab20)
- Change: https://github.com/ClickHouse/ClickHouse/pull/101074/files (9 changed lines in 3 files, C++)
- Commits: base cef81be62ebc151aed7b98e9e11059ca2250518c, head 90f373b0f63e9274a8a003c4a8ed783d0b780cc5; merged 2026-03-29T19:24:00Z as https://github.com/ClickHouse/ClickHouse/commit/c037aa07f83814496fbfc5ad61d14b265fdfe9d6
- Licence: Apache-2.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-27T19:24:00Z (read 2026-10-12): 2 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on src/Processors/Formats/Impl/RegexpRowInputFormat.cpp:
  - 2026-03-29T23:20:54Z https://github.com/ClickHouse/ClickHouse/commit/371e0b496d41773dfa7d268ebb4bed47f1c48664 "Merge remote-tracking branch 'origin/master' into fix-compiler-warnings": its first parent does not hold the pull request (a commit on another branch's line, or a merge into one)
  - 2026-06-13T12:57:34Z https://github.com/ClickHouse/ClickHouse/commit/0b06c626d8a97f5e889fa0499f34d88f7ecbef9b "Move embedded format documentation into each format's own source file": its changes miss the pull request's lines, which sit at 25 to 27 of its parent
- Ruling: 

## 20. Use compression_settings in size_utils

- Case: clean/timescale__timescaledb-9329@ed4324e7 (evidence 108c21ca0027)
- Change: https://github.com/timescale/timescaledb/pull/9329/files (21 changed lines in 1 file, C)
- Commits: base f6639545b4aa32669c48ebfd45c27697407efe2d, head ad91eea5acc5dbc2dd5ea654ded6c6427d881298; merged 2026-03-04T07:13:29Z as https://github.com/timescale/timescaledb/commit/85229fd60f4ae65af42adeba6b7fb27f6005532f
- Licence: NOASSERTION, LICENSE (unverified: used and published in full)
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-06-02T07:13:29Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on sql/size_utils.sql:
  - 2026-05-02T19:23:06Z https://github.com/timescale/timescaledb/commit/f5020d4ccf34afaa5e50e77f9efef05886905bd7 "Use bigint in estimate_uncompressed_size calculations": its changes miss the pull request's lines, which sit at 42 to 43, 378, 380, 397, 399 to 400 of its parent
- Ruling: 

## 21. Fixed a call hierarchy crash in arrow prop declaration in exported default class

- Case: clean/microsoft__typescript-go-3296@dd0070f5 (evidence ffbedd8af213)
- Change: https://github.com/microsoft/typescript-go/pull/3296/files (77 changed lines in 3 files, Go)
- Commits: base f017c028e8e6f8be12cae867533c26a0c65546b3, head 694c0be8d4d26bb87e163a91220f05e7a6dae324; merged 2026-03-30T00:28:53Z as https://github.com/microsoft/typescript-go/commit/8a834dad086d6912b091e8b467e98499dab68cd9
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T00:28:53Z (read 2026-10-12): 1 later commit on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on internal/ls/callhierarchy.go:
  - 2026-05-11T15:33:59Z https://github.com/microsoft/typescript-go/commit/82590062cc8be09ec97755b53bd5ee63d2db3010 "Fix crashes related to call hierarchy container names for computed properties (#3786)": its changes miss the pull request's lines, which sit at 261 of its parent
- Ruling: 

## 22. [API Nodes] made Reve node price badges more precise

- Case: clean/Comfy-Org__ComfyUI-13154@b2ed02b9 (evidence 8f4d54adf745)
- Change: https://github.com/Comfy-Org/ComfyUI/pull/13154/files (43 changed lines in 1 file, Python)
- Commits: base b53b10ea61ef7fc54fbde7c1e7b7c36565bacf82, head f291cec5d28730f62e9c584b4734e0189ab743a4; merged 2026-03-25T18:05:50Z as https://github.com/Comfy-Org/ComfyUI/commit/a55835f10c29c1acdc9158bf9e092656ae1a2188
- Licence: GPL-3.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-23T18:05:50Z (read 2026-10-12): 2 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on comfy_api_nodes/nodes_reve.py:
  - 2026-05-28T00:43:33Z https://github.com/Comfy-Org/ComfyUI/commit/174208df6ba033e5b4784c94d83d065c0d4165a4 "chore: Update nodes categories (#14145)": its changes miss the pull request's lines, which sit at 148 to 161, 241, 245, 247 to 255, 351, 355, 357 to 365 of its parent
  - 2026-06-02T04:24:46Z https://github.com/Comfy-Org/ComfyUI/commit/e88a81d316205bf3c3f9293778b78f5949e82e97 "Revert partner nodes category (#14229)": its changes miss the pull request's lines, which sit at 148 to 161, 241, 245, 247 to 255, 351, 355, 357 to 365 of its parent
- Ruling: 

## 23. ci(cypress): fix worldpay cypress test

- Case: clean/juspay__hyperswitch-11465@a7bb498e (evidence 20b2d06dde90)
- Change: https://github.com/juspay/hyperswitch/pull/11465/files (4 changed lines in 1 file, Rust)
- Commits: base 747ed7e459d19fae525b5dc9596fc76b58326ef3, head 8f13e7bce791bb1a2b12146abb0cb7da5b8d4bc8; merged 2026-03-11T12:03:01Z as https://github.com/juspay/hyperswitch/commit/1752924d20e834120d23a4b058f450ddd388024d
- Licence: Apache-2.0, LICENSE
- Reviews by others: 3 (approved 2, dismissed 1); none requested changes
- Checked up to 2026-06-09T12:03:01Z (read 2026-10-12): 3 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on cypress-tests/cypress/e2e/configs/Payment/WorldPay.js:
  - 2026-03-31T13:50:35Z https://github.com/juspay/hyperswitch/commit/5aa2452ca212050f9ae47b35b5042e8ae5a19894 "ci(cypress): added payment webhook fixtures (#11612)": its changes miss the pull request's lines, which sit at 672 to 673 of its parent
  - 2026-04-10T19:48:36Z https://github.com/juspay/hyperswitch/commit/2ef119e5c28402365e43a0288de092f6eaa9e917 "ci(cypress): added refund webhooks for supported connectors (#11754)": its changes miss the pull request's lines, which sit at 672 to 673 of its parent
  - 2026-05-03T07:20:52Z https://github.com/juspay/hyperswitch/commit/14117dfaf2c793a204f82cb1c4eea0af9ac961fb "test(cypress): add PartialAuthorization coverage for nuvei, checkout, worldpay, worldpayvantiv (#12061)": its changes miss the pull request's lines, which sit at 672 to 673 of its parent
- Ruling: 

## 24. fix(editor): Fix `/diff` route loading in demo mode

- Case: clean/n8n-io__n8n-27610@5d021fdd (evidence 86f8f4248791)
- Change: https://github.com/n8n-io/n8n/pull/27610/files (6 changed lines in 1 file, TypeScript)
- Commits: base d3e45bc126258c86dfcf81282b0e28bc1088bf54, head 7a617e72ad4a46e45ba1b7aa01c72a183d1b8d77; merged 2026-03-26T13:04:26Z as https://github.com/n8n-io/n8n/commit/197a4314b39dc873c6e13fd9cd8164971d53023a
- Licence: NOASSERTION, LICENSE.md (unverified: used and published in full)
- Reviews by others: 3 (approved 1, commented 1, dismissed 1); none requested changes
- Checked up to 2026-06-24T13:04:26Z (read 2026-10-12): 15 later commits on its files, each read line by line (3 reading as a fix, revert or follow-up), none touching its lines
- Later commits on packages/frontend/editor-ui/src/app/composables/useWorkflowInitialization.ts:
  - 2026-04-07T00:37:52Z https://github.com/n8n-io/n8n/commit/4aba06d78e23cac40a662cc15cffe93fc0a51502 "refactor(editor): Migrate workflow name to workflowDocument store (#27343)": its changes miss the pull request's lines, which sit at 2, 55 to 56, 90 of its parent
  - 2026-04-14T11:03:50Z https://github.com/n8n-io/n8n/commit/c9cab112f99a5da2742012773450bf7721484c28 "fix(editor): Show relevant node in workflow activation errors (#26691)": its changes miss the pull request's lines, which sit at 2, 55 to 56, 90 of its parent
  - 2026-04-21T09:17:45Z https://github.com/n8n-io/n8n/commit/b444a95e117133d41c22afbe57d9f7e8db8189f3 "refactor(editor): Migrate workflow object usages (#28534)": its changes miss the pull request's lines, which sit at 2, 55 to 56, 90 of its parent
  - 2026-04-23T12:14:42Z https://github.com/n8n-io/n8n/commit/9415f441d9cebefe6db5458874266f61056ab447 "refactor(editor): Migrate deprecated methods in useWorkflowState (#28672)": its changes miss the pull request's lines, which sit at 2, 55 to 56, 90 of its parent
  - 2026-04-27T14:37:07Z https://github.com/n8n-io/n8n/commit/e028204c5690e3b691f1b4182647c6c548235955 "refactor(editor): Provide workflow id and document store at app root (no-changelog) (#29297)": its changes miss the pull request's lines, which sit at 2, 55 to 56, 90 of its parent
  - 2026-04-29T15:08:36Z https://github.com/n8n-io/n8n/commit/9a91c83a274cd2ee6ae9658ce42f3df150333d24 "refactor(editor): Scope NDV store per workflow document (no-changelog) (#29392)": its changes miss the pull request's lines, which sit at 2, 60 to 61, 90 of its parent
  - 2026-05-04T11:46:38Z https://github.com/n8n-io/n8n/commit/d422d2bafb7fc65f2c70fdea8b9d50ab922d34d4 "refactor(editor): Introduce setter facades for workflow execution state (no-changelog) (#29675)": its changes miss the pull request's lines, which sit at 2, 62 to 63, 97 of its parent
  - 2026-05-06T11:42:12Z https://github.com/n8n-io/n8n/commit/bec74aeb4fda198853b3ea82ed135a1db3ba4988 "fix(core): Add workflow structure validation (#29699)": its changes miss the pull request's lines, which sit at 2, 62 to 63, 97 of its parent
  - 2026-05-19T07:51:37Z https://github.com/n8n-io/n8n/commit/21a309015248587edc84fae8c230db0940b05bca "fix(editor): Restore workflow name in window tab title (#29826)": its changes miss the pull request's lines, which sit at 2, 63 to 64, 98 of its parent
  - 2026-05-28T11:51:24Z https://github.com/n8n-io/n8n/commit/1eee149ab8b8aa97e710c04ff2550ff0f4965280 "refactor(editor): Move session state off workflows-store bridge (no-changelog) (#31138)": its changes miss the pull request's lines, which sit at 2, 63 to 64, 98 of its parent
  - 2026-06-01T10:21:39Z https://github.com/n8n-io/n8n/commit/4188a7c4ed32e50464758cccfb9f6d12206a9c39 "refactor(editor): Drop `NDVStoreKey` and `currentNDVStore` scaffolding (no-changelog) (#31270)": its changes miss the pull request's lines, which sit at 2, 64 to 65, 99 of its parent
  - 2026-06-02T13:12:48Z https://github.com/n8n-io/n8n/commit/a724624b1afa40e88422111cc83ec57858bd0848 "refactor(editor): Migrate `getNewWorkflowData` to the workflows API (#31556)": its changes miss the pull request's lines, which sit at 2, 63 to 64, 93 of its parent
  - 2026-06-04T12:06:06Z https://github.com/n8n-io/n8n/commit/15749aa39ec8a1c50f8bb333b5c37e06eae6cf27 "refactor(editor): Resolve workflow push handlers by id and remove workflow state store and composable (no-changelog) (#31514)": its changes miss the pull request's lines, which sit at 2, 66 to 67, 96 of its parent
  - 2026-06-18T14:14:09Z https://github.com/n8n-io/n8n/commit/e0f4f93afbc098b777b460a104c74d2b3be5f674 "refactor(editor): Resolve workflow id from document store and route (no-changelog) (#32462)": its changes miss the pull request's lines, which sit at 2, 65 to 66, 93 of its parent
  - 2026-06-22T09:05:49Z https://github.com/n8n-io/n8n/commit/bbd05005125004003ed9f933d8ea49ec84c93b57 "refactor(editor): Thread outgoing workflow id through workspace teardown (no-changelog) (#32734)": its changes miss the pull request's lines, which sit at 2, 65 to 66, 93 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/n8n-io/n8n/pull/27765 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27771 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27772 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27778 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27781 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27786 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27787 ":rocket: Release 2.15.0"; https://github.com/ATHEO-Ingenierie/n8n-helm/pull/32 "Update n8n appVersion to 2.15.0"
- Ruling: 

## 25. Fix transient user stats animation changing speed after first display

- Case: clean/ppy__osu-36738@0b937f98 (evidence 834fbd681686)
- Change: https://github.com/ppy/osu/pull/36738/files (123 changed lines in 4 files, C#)
- Commits: base d139f5997c4e282bd4f2f9f246e1854b36f93a83, head f39615a374afce4c880e02c645a888b8ceffd60e; merged 2026-02-24T07:19:03Z as https://github.com/ppy/osu/commit/e2cbfb970ee24ef04a716f83fb3d22798146a983
- Licence: MIT, LICENCE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-05-25T07:19:03Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on osu.Game/Overlays/Toolbar/ToolbarButton.cs:
  - 2026-02-25T07:31:36Z https://github.com/ppy/osu/commit/0dfb362b2d9cc82a25517e794c26f2cdc4192c0a "Use `HotkeyDisplay` for toolbar buttons (#36750)": its changes miss the pull request's lines, which sit at 47 to 48, 63 to 64, 119 to 120, 133 to 134 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/LumpBloom7/sentakki/pull/780 "Bump ppy.osu.Game from 2026.213.0 to 2026.303.0"; https://github.com/GooGuTeam/osu-performance-server/pull/31 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/564 "Bump ppy.osu.Game from 2026.213.0 to 2026.303.0"; https://github.com/GooGuTeam/custom-rulesets/pull/31 "Bump the osu-game group with 5 updates"; https://github.com/Rudicito/gitaroo/pull/76 "Bump ppy.osu.Game from 2026.119.0 to 2026.303.0"; https://github.com/goodtrailer/soyokaze/pull/249 "Bump ppy.osu.Game from 2026.102.0 to 2026.303.0"; https://github.com/taulazer/tau/pull/571 "Bump ppy.osu.Game from 2026.213.0 to 2026.303.0"; https://github.com/LumpBloom7/hishigata/pull/315 "Bump ppy.osu.Game from 2025.1029.0 to 2026.303.0"; https://github.com/Rudicito/gitaroo/pull/77 "Bump ppy.osu.Game from 2026.119.0 to 2026.315.0"; https://github.com/goodtrailer/soyokaze/pull/250 "Bump ppy.osu.Game from 2026.102.0 to 2026.315.0"; https://github.com/GooGuTeam/osu-performance-server/pull/33 "Bump the osu-game group with 5 updates"; https://github.com/GooGuTeam/custom-rulesets/pull/32 "Bump the osu-game group with 5 updates"; https://github.com/Rudicito/gitaroo/pull/78 "Bump ppy.osu.Game from 2026.119.0 to 2026.317.0"; https://github.com/goodtrailer/soyokaze/pull/251 "Bump ppy.osu.Game from 2026.102.0 to 2026.317.0"; https://github.com/GooGuTeam/osu-performance-server/pull/34 "Bump the osu-game group with 5 updates"; https://github.com/Game4all/gamebosu/pull/287 "Bump ppy.osu.Game from 2025.816.0 to 2026.408.0"; https://github.com/Game4all/gamebosu/pull/289 "Bump ppy.osu.Game from 2025.816.0 to 2026.429.0"; https://github.com/Game4all/gamebosu/pull/291 "Bump ppy.osu.Game from 2025.816.0 to 2026.505.0"
- Ruling: 

## 26. fix(voyager): fix race condition with multiple voyagers updating the same client

- Case: clean/unionlabs__union-5396@6a346443 (evidence 222d76424d7c)
- Change: https://github.com/unionlabs/union/pull/5396/files (10 changed lines in 1 file, Rust)
- Commits: base 6cbbb4f8ae3334e66f1d45ccf6be5a6aa258731f, head 5fbfd93cb30623e450fbf901c64dfda0f0af3c11; merged 2026-01-20T12:04:08Z as https://github.com/unionlabs/union/commit/00ccdd10156f985d700a8fbebd93c648e67c8a0f
- Licence: Apache-2.0, LICENSE-APACHE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-04-20T12:04:08Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on voyager/plugins/transaction-batch/src/callback.rs:
  - 2026-01-26T14:39:29Z https://github.com/unionlabs/union/commit/eac11e32240b7eba2b60823547ebee190ac79d65 "feat: parlia and proof lens clients + voyager plugins & modules": its changes miss the pull request's lines, which sit at 84 to 85 of its parent
- Ruling: 

## 27. Rename search hits

- Case: clean/elastic__elasticsearch-145252@a2c9e075 (evidence 8af683d2ddd4)
- Change: https://github.com/elastic/elasticsearch/pull/145252/files (4 changed lines in 1 file, Java)
- Commits: base 8d0f31d7ffd44514a8bb4367bc2aafee8c3bdd09, head 7f1cc1b0320bb3c071befa5ac24942898bd18d3e; merged 2026-03-31T17:51:18Z as https://github.com/elastic/elasticsearch/commit/7ec12824b2ec23d2942f874048682ee9fc6ce823
- Licence: NOASSERTION, LICENSE.txt (unverified: used and published in full)
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-29T17:51:18Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 28. GLSLDecoder: Replace deprecated `substr()` with `slice()`.

- Case: clean/mrdoob__three.js-33260@89866e8c (evidence 51eb5f9e85ce)
- Change: https://github.com/mrdoob/three.js/pull/33260/files (4 changed lines in 1 file, JavaScript)
- Commits: base 02de89f05a72761a06adb4ccc78200b8f8208ac8, head e78b92bf148af75c918773c2622afaa74e5eefd4; merged 2026-03-28T08:33:00Z as https://github.com/mrdoob/three.js/commit/f0a65ef67e50d3c6ee158d2198b8fe6910484479
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-26T08:33:00Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on examples/jsm/transpiler/GLSLDecoder.js:
  - 2026-05-16T11:24:46Z https://github.com/mrdoob/three.js/commit/2654e309863f6f93e9c77c302521b00c85c89dc5 "Global: Harmonize errors. (#33588)": its changes miss the pull request's lines, which sit at 173, 185 of its parent
- Ruling: 

## 29. [DevTools] Ignore new production renderers if we already use "worse" versions of React on a page

- Case: clean/react__react-35994@4c43106e (evidence 30505630c432)
- Change: https://github.com/react/react/pull/35994/files (104 changed lines in 6 files, JavaScript)
- Commits: base 014138df87869b174956f90a33fd6cf66e160114, head 209a41cdcffefcc3364f606e645dd9c0a756acf1; merged 2026-03-11T09:26:36Z as https://github.com/react/react/commit/7b5b561bd2dda205ed8f397864379003b707d4ae
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-09T09:26:36Z (read 2026-10-12): 2 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on packages/react-devtools-shared/src/hook.js:
  - 2026-06-05T17:54:38Z https://github.com/react/react/commit/fbb137059e4aacfaab1d36516e9b55050b4a0454 "[flow] Bump flow to v0.307.1 (#36199)": its changes miss the pull request's lines, which sit at 20, 75, 215 of its parent
  - 2026-06-05T23:17:18Z https://github.com/react/react/commit/900ae094d85b11c67d53dd14af50a2bda5db4495 "[flow] Bump flow to v0.317.0 (#36701)": its changes miss the pull request's lines, which sit at 20, 75, 215 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/vercel/next.js/pull/91272 "Upgrade React from `46103596-20260305` to `5e9eedb5-20260312`"
- Ruling: 

## 30. Fix editor not updating titlebar with new difficulty name after rename

- Case: clean/ppy__osu-36908@97de402f (evidence e65ab2c02639)
- Change: https://github.com/ppy/osu/pull/36908/files (16 changed lines in 1 file, C#)
- Commits: base 321e6989061246275f30ef80030fe560109291fd, head ec66e93d5f7336fdb2aa5e5e9a5eeb2003136042; merged 2026-03-10T08:57:26Z as https://github.com/ppy/osu/commit/9105fc15b244a0c3a4d59241d7529de7562500cb
- Licence: MIT, LICENCE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-08T08:57:26Z (read 2026-10-12): 6 later commits on its files, each read line by line (3 reading as a fix, revert or follow-up), none touching its lines
- Later commits on osu.Game/Screens/Edit/Editor.cs:
  - 2026-03-23T08:26:34Z https://github.com/ppy/osu/commit/95648a3d27a0c9c4e544c445f9baba4a8c5b8948 "Fix editor background taking too long to load with certain storyboards (#37038)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 606 to 608 of its parent
  - 2026-04-24T03:39:55Z https://github.com/ppy/osu/commit/0fa7824a23e70944a3336e10ccec234771b3b7bc "Add localisation support for some more notifications (#37237)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 604 to 606 of its parent
  - 2026-05-08T07:35:20Z https://github.com/ppy/osu/commit/26266321dd935220865d9a66fa7756078f75423b "Add ability to sync metadata across difficulties in editor setup (#37465)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 604 to 606 of its parent
  - 2026-05-08T08:25:22Z https://github.com/ppy/osu/commit/e6fdd37e763a600c9d3a8606c9afb2186ed3f3f4 "Restore editor mode when changing difficulty (#37671)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 604 to 606 of its parent
  - 2026-05-18T09:17:44Z https://github.com/ppy/osu/commit/c0cc6cdbf1800ccc2f592c6dd3562235d8ed515a "Add editor hotkeys for beatmap submit and edit externally (#37782)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 606 to 608 of its parent
  - 2026-05-20T08:46:51Z https://github.com/ppy/osu/commit/0e443b1c4729073b7151bb17f9ef8615b6c7196f "Add legacy storyboard encoder (#37790)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 606 to 608 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/LumpBloom7/hishigata/pull/317 "Bump ppy.osu.Game from 2026.303.0 to 2026.315.0"; https://github.com/Rudicito/gitaroo/pull/77 "Bump ppy.osu.Game from 2026.119.0 to 2026.315.0"; https://github.com/goodtrailer/soyokaze/pull/250 "Bump ppy.osu.Game from 2026.102.0 to 2026.315.0"; https://github.com/LumpBloom7/sentakki/pull/823 "Bump ppy.osu.Game from 2026.303.0 to 2026.315.0"; https://github.com/Beamographic/rush/pull/428 "Bump ppy.osu.Game from 2026.303.0 to 2026.315.0"; https://github.com/GooGuTeam/osu-performance-server/pull/33 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/581 "Bump ppy.osu.Game from 2026.303.0 to 2026.317.0"; https://github.com/GooGuTeam/custom-rulesets/pull/32 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/hishigata/pull/318 "Bump ppy.osu.Game from 2026.303.0 to 2026.317.0"; https://github.com/Rudicito/gitaroo/pull/78 "Bump ppy.osu.Game from 2026.119.0 to 2026.317.0"; https://github.com/goodtrailer/soyokaze/pull/251 "Bump ppy.osu.Game from 2026.102.0 to 2026.317.0"; https://github.com/LumpBloom7/sentakki/pull/825 "Bump NUnit and ppy.osu.Game"; https://github.com/GooGuTeam/osu-performance-server/pull/34 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/sentakki/pull/835 "Bump NUnit and ppy.osu.Game"; https://github.com/GooGuTeam/osu-performance-server/pull/35 "Bump the osu-game group with 5 updates"; https://github.com/GooGuTeam/custom-rulesets/pull/33 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/hishigata/pull/320 "Bump ppy.osu.Game from 2026.303.0 to 2026.406.0"; https://github.com/Rudicito/gitaroo/pull/80 "Bump ppy.osu.Game from 2026.303.0 to 2026.406.0"; https://github.com/goodtrailer/soyokaze/pull/252 "Bump ppy.osu.Game from 2026.317.0 to 2026.406.0"; https://github.com/taulazer/tau/pull/584 "Bump ppy.osu.Game from 2026.303.0 to 2026.406.0"; https://github.com/goodtrailer/soyokaze/pull/253 "Bump ppy.osu.Game from 2026.317.0 to 2026.408.0"; https://github.com/LumpBloom7/sentakki/pull/837 "Bump NUnit and ppy.osu.Game"; https://github.com/GooGuTeam/osu-performance-server/pull/36 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/585 "Bump ppy.osu.Game from 2026.303.0 to 2026.408.0"; https://github.com/GooGuTeam/custom-rulesets/pull/34 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/hishigata/pull/322 "Bump ppy.osu.Game from 2026.303.0 to 2026.408.0"; https://github.com/Game4all/gamebosu/pull/287 "Bump ppy.osu.Game from 2025.816.0 to 2026.408.0"; https://github.com/goodtrailer/soyokaze/pull/254 "Bump ppy.osu.Game from 2026.317.0 to 2026.429.0"; https://github.com/GooGuTeam/osu-performance-server/pull/38 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/587 "Bump ppy.osu.Game from 2026.303.0 to 2026.429.0"; https://github.com/GooGuTeam/custom-rulesets/pull/39 "Bump the osu-game group with 5 updates"; https://github.com/Game4all/gamebosu/pull/289 "Bump ppy.osu.Game from 2025.816.0 to 2026.429.0"; https://github.com/goodtrailer/soyokaze/pull/255 "Bump ppy.osu.Game from 2026.317.0 to 2026.505.0"; https://github.com/GooGuTeam/osu-performance-server/pull/39 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/589 "Bump ppy.osu.Game from 2026.303.0 to 2026.505.0"; https://github.com/GooGuTeam/custom-rulesets/pull/40 "Bump the osu-game group with 5 updates"; https://github.com/Game4all/gamebosu/pull/291 "Bump ppy.osu.Game from 2025.816.0 to 2026.505.0"; https://github.com/goodtrailer/soyokaze/pull/256 "Bump ppy.osu.Game from 2026.317.0 to 2026.518.0"; https://github.com/GooGuTeam/osu-performance-server/pull/41 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/590 "Bump ppy.osu.Game from 2026.303.0 to 2026.518.0"; https://github.com/GooGuTeam/custom-rulesets/pull/41 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/592 "Bump ppy.osu.Game from 2026.303.0 to 2026.522.0"; https://github.com/GooGuTeam/custom-rulesets/pull/42 "Bump the osu-game group with 5 updates"; https://github.com/goodtrailer/soyokaze/pull/257 "Bump ppy.osu.Game from 2026.317.0 to 2026.522.0"; https://github.com/GooGuTeam/osu-performance-server/pull/42 "Bump the osu-game group with 5 updates"; https://github.com/GooGuTeam/osu-performance-server/pull/43 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/594 "Bump ppy.osu.Game from 2026.303.0 to 2026.527.0"; https://github.com/GooGuTeam/custom-rulesets/pull/43 "Bump the osu-game group with 5 updates"; https://github.com/goodtrailer/soyokaze/pull/258 "Bump ppy.osu.Game from 2026.317.0 to 2026.527.0"; https://github.com/goodtrailer/soyokaze/pull/259 "Bump ppy.osu.Game from 2026.317.0 to 2026.601.0"; https://github.com/taulazer/tau/pull/595 "Bump ppy.osu.Game from 2026.303.0 to 2026.601.0"; https://github.com/GooGuTeam/custom-rulesets/pull/44 "Bump the osu-game group with 5 updates"; https://github.com/goodtrailer/soyokaze/pull/260 "Bump ppy.osu.Game from 2026.317.0 to 2026.605.0"; https://github.com/taulazer/tau/pull/596 "Bump ppy.osu.Game from 2026.303.0 to 2026.605.0"; https://github.com/GooGuTeam/custom-rulesets/pull/45 "Bump ppy.osu.Game and 4 others"
- Ruling: 

## 31. ci: use LLVM/Clang 22 in tidy job

- Case: clean/bitcoin__bitcoin-34662@b2b782ee (evidence c94acad602a7)
- Change: https://github.com/bitcoin/bitcoin/pull/34662/files (11 changed lines in 5 files, C++)
- Commits: base bf9ef4f0433551e850a11c2da8baae0ec6439a99, head 5e35a9069d655419cada6070e1f00a28d4a877f9; merged 2026-03-03T22:40:36Z as https://github.com/bitcoin/bitcoin/commit/17a04039bc5befd51c2f96daf081e9e4a8ed7bff
- Licence: MIT, COPYING
- Reviews by others: 6 (approved 1, commented 5); none requested changes
- Checked up to 2026-06-01T22:40:36Z (read 2026-10-12): 14 later commits on its files, each read line by line (9 reading as a fix, revert or follow-up), none touching its lines
- Later commits on ci/test/03_test_script.sh:
  - 2026-03-11T10:37:23Z https://github.com/bitcoin/bitcoin/commit/d03e3be246f64065002268e74ee9a834089de37a "ci: check macos bundle structure and codesigning": its changes miss the pull request's lines, which sit at 177 of its parent
  - 2026-03-11T12:01:24Z https://github.com/bitcoin/bitcoin/commit/f25843d8ad072205d20651ae6e33eb2b3118c7be "Merge bitcoin/bitcoin#34441: ci: Allow running iwyu CI in worktree": its changes miss the pull request's lines, which sit at 177 of its parent
  - 2026-03-13T10:16:48Z https://github.com/bitcoin/bitcoin/commit/390e7d61bd531505bb3d13f38316c282b85ed1dd "Merge bitcoin/bitcoin#34787: build: fix native macOS deployment": its changes miss the pull request's lines, which sit at 195 of its parent
  - 2026-03-24T20:23:35Z https://github.com/bitcoin/bitcoin/commit/3129d4a69345324de3658bf3a1cb5eee23f6bae8 "ci: Rename `TIDY_LLVM_V` to `IWYU_LLVM_V` in IWYU-specific code": its changes miss the pull request's lines, which sit at 203 of its parent
  - 2026-03-30T15:34:48Z https://github.com/bitcoin/bitcoin/commit/6953363be8c020912a3f69db663ed920f4959d00 "refactor: Move license info into new module": its changes miss the pull request's lines, which sit at 203 of its parent
  - 2026-03-30T15:39:42Z https://github.com/bitcoin/bitcoin/commit/8b49e2dd4eed93d08a3d9681d444aaf441ab0037 "ci, iwyu: Fix warnings in `src/util` and treat them as errors": its changes miss the pull request's lines, which sit at 203 of its parent
  - 2026-05-14T11:09:35Z https://github.com/bitcoin/bitcoin/commit/fac6c4270dac566ebf274a5c18e30810a3da70f9 "ci: Put space and non-ASCII char in scratch dir": its changes miss the pull request's lines, which sit at 203 of its parent
  - 2026-05-21T16:39:59Z https://github.com/bitcoin/bitcoin/commit/fa99a3ccacead02c26ea74c0e12cd845c4dafb91 "ci: Enable pipefail in 03_test_script.sh": its changes miss the pull request's lines, which sit at 203 of its parent
  - 2026-05-22T06:33:37Z https://github.com/bitcoin/bitcoin/commit/0317f52022cd34a2fb6647f0a85ad6537d7cc820 "ci: enforce iwyu for touched files": its changes miss the pull request's lines, which sit at 203 of its parent
  - 2026-05-22T11:36:39Z https://github.com/bitcoin/bitcoin/commit/b9f0040caf45355c4621e792df09fffabf23495e "Merge bitcoin/bitcoin#34614: ci: Put space and non-ASCII char in scratch dir": its changes miss the pull request's lines, which sit at 223 of its parent
  - 2026-05-26T12:39:03Z https://github.com/bitcoin/bitcoin/commit/a4157fc24a29118b1c9d1ac5b7977104217bcee9 "Merge bitcoin/bitcoin#33966: refactor: disentangle miner startup defaults from runtime options": its changes miss the pull request's lines, which sit at 223 of its parent
  - 2026-05-27T14:53:42Z https://github.com/bitcoin/bitcoin/commit/fa98d449517da406203e042aaccb8acc698d7a0c "ci: Rewrite broken wrap-valgrind.sh to .py": its changes miss the pull request's lines, which sit at 223 of its parent
  - 2026-05-29T08:36:08Z https://github.com/bitcoin/bitcoin/commit/6183942513789fb3dc94fa02a097744b149bb69a "ci, iwyu: Fix warnings in src/scripts and treat them as error": its changes miss the pull request's lines, which sit at 223 of its parent
- Later commits on src/script/interpreter.cpp:
  - 2026-05-29T08:36:08Z https://github.com/bitcoin/bitcoin/commit/6183942513789fb3dc94fa02a097744b149bb69a "ci, iwyu: Fix warnings in src/scripts and treat them as error": its changes miss the pull request's lines, which sit at 1260 to 1263 of its parent
- Ruling: 

## 32. Remove transitive AspNetCore.App framework reference in trimming tests

- Case: clean/dotnet__aspnetcore-65793@732ecc80 (evidence 3492cb91fc7d)
- Change: https://github.com/dotnet/aspnetcore/pull/65793/files (14 changed lines in 1 file, C#)
- Commits: base 5b892736c24f973adbdc8a36542609dc403ed92d, head 9f37385a85b64b4572fed60474bdb3854b9924bd; merged 2026-03-18T09:58:50Z as https://github.com/dotnet/aspnetcore/commit/f7c186e94f7853eb90ff600f3486a1d6733a1de8
- Licence: MIT, LICENSE.txt
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-16T09:58:50Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on eng/testing/linker/SupportFiles/Directory.Build.targets:
  - 2026-06-05T08:59:33Z https://github.com/dotnet/aspnetcore/commit/1a6684cc0ca0d72f6124bbd51b7dfe5405f4f011 "Implement Cross-Site Request Forgery Algorithm based on Fetch Metadata headers (#66585)": its changes miss the pull request's lines, which sit at 66 to 79 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/dotnet/dotnet/pull/5587 "[main] Source code updates from dotnet/aspnetcore"
- Ruling: 

## 33. Add missing Slovak chart filter action translations

- Case: clean/filamentphp__filament-19318@d64ad624 (evidence 46ffd7e8ec16)
- Change: https://github.com/filamentphp/filament/pull/19318/files (16 changed lines in 1 file, PHP)
- Commits: base be9a8da37577cf2d73fe19a3ef93caaea0478099, head ebf7b147a4c538ef414f87a89dcd85c30aa65ff5; merged 2026-02-23T08:24:19Z as https://github.com/filamentphp/filament/commit/ada995d009434685500d674d24e0abb5680d4780
- Licence: MIT, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-24T08:24:19Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 34. [DevTools] Don't capture durations for disconnected subtrees when profiling

- Case: clean/react__react-35718@52edac83 (evidence 616b8f4ea269)
- Change: https://github.com/react/react/pull/35718/files (79 changed lines in 2 files, JavaScript)
- Commits: base 65db1000b944c8a07b5947c06b38eb8364dce4f2, head a1c0c6d100a02840f7e78a60f0803849fa236631; merged 2026-02-09T22:18:17Z as https://github.com/react/react/commit/c6bb26bf833c5d91760daf28fa2750b81067ac30
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-10T22:18:17Z (read 2026-10-12): 10 later commits on its files, each read line by line (2 reading as a fix, revert or follow-up), none touching its lines
- Later commits on packages/react-devtools-shared/src/__tests__/profilingCommitTreeBuilder-test.js:
  - 2026-02-10T11:51:58Z https://github.com/react/react/commit/49c3b270f9991fbecbe2b9c29c27e19a54fb4466 "[test] Include `uniqueSuspenders` in Suspense tree snapshots (#35736)": its changes miss the pull request's lines, which sit at 194 to 262 of its parent
- Later commits on packages/react-devtools-shared/src/backend/fiber/renderer.js:
  - 2026-02-10T12:09:23Z https://github.com/react/react/commit/f23aa1d9f5034e7cfbd3e6015ce102bb72a005a0 "[DevTools] Fix memory leak when unmounting hoistables (#35741)": its changes miss the pull request's lines, which sit at 5584 to 5589 of its parent
  - 2026-02-10T15:35:02Z https://github.com/react/react/commit/70890e7c58abccef35a6498f7ee702d608be79d6 "Consistent handling of work tags for rename, delete, and overriding state (#35740)": its changes miss the pull request's lines, which sit at 5584 to 5589 of its parent
  - 2026-02-10T16:52:35Z https://github.com/react/react/commit/57b79b0388b755096216b2b5308113e54eac3be8 "[DevTools] Only block child Suspense boundaries if the parent has all shared suspenders removed (#35737)": its changes miss the pull request's lines, which sit at 5584 to 5589 of its parent
  - 2026-02-10T23:35:36Z https://github.com/react/react/commit/e49335e961a77a45be32ad6c9c1877cbe2fe91f4 "[DevTools] Display `React.optimisticKey` in key positions (#35760)": its changes miss the pull request's lines, which sit at 5585 to 5590 of its parent
  - 2026-02-11T16:59:43Z https://github.com/react/react/commit/8374c2abf13fa803233025192b8d7e87de70b087 "[DevTools] Remove experimental __IS_INTERNAL_MCP_BUILD__ flag and related code (#35755)": its changes miss the pull request's lines, which sit at 5590 to 5595 of its parent
  - 2026-03-03T12:27:05Z https://github.com/react/react/commit/aac12ce597b49093a5add54b00deee3d8980f874 "[DevTools] chore: extract pure functions from fiber/renderer.js (#35924)": its changes miss the pull request's lines, which sit at 5590 to 5595 of its parent
  - 2026-03-10T17:05:48Z https://github.com/react/react/commit/014138df87869b174956f90a33fd6cf66e160114 "[DevTools] Fix a crash when rendering a new class Component when simulating errored state (#35985)": its changes miss the pull request's lines, which sit at 5267 to 5272 of its parent
  - 2026-03-20T14:17:15Z https://github.com/react/react/commit/8b2e903a7447d370eb77bb117bc4c0ae240ce831 "[DevTools] chore: extract getInternalReactConstants (#35986)": its changes miss the pull request's lines, which sit at 5267 to 5272 of its parent
  - 2026-03-23T14:29:38Z https://github.com/react/react/commit/ed69815cebae33b0326cc69faa90f813bb924f3b "[DevTools] feat: display subtree for Activity and dim in hidden mode (#36094)": its changes miss the pull request's lines, which sit at 4778 to 4783 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/vercel/next.js/pull/89923 "Upgrade React from `272441a9-20260209` to `6066c782-20260212`"
- Ruling: 

## 35. Deflake Restart target replica during migration (without save) causes success test

- Case: clean/valkey-io__valkey-3226@a1cd5c3b (evidence 0c00776fc776)
- Change: https://github.com/valkey-io/valkey/pull/3226/files (20 changed lines in 1 file, C)
- Commits: base 4dee322edeb9c96029d89cfaf1600abad2afead0, head feeb16034cd1cf93533083f879506e45e5c914b3; merged 2026-02-27T02:42:50Z as https://github.com/valkey-io/valkey/commit/75fb0e6cbb7ce7e6762951b6b97083c433e5b4c1
- Licence: BSD-3-Clause, COPYING
- Reviews by others: 7 (approved 6, commented 1); none requested changes
- Checked up to 2026-05-28T02:42:50Z (read 2026-10-12): 2 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on tests/unit/cluster/cluster-migrateslots.tcl:
  - 2026-04-08T08:26:29Z https://github.com/valkey-io/valkey/commit/dba128f13b7486322fe3b52a8358bd9188ec613a "Fix slot-migration-max-failover-repl-bytes unable to accept -1 (#3443)": its changes miss the pull request's lines, which sit at 2095 to 2099, 2108 to 2112, 2120 to 2125 of its parent
  - 2026-05-15T03:55:59Z https://github.com/valkey-io/valkey/commit/390a11c895d5dd1aa570ef7b6e78206ab1bf9776 "Set repl-timeout for slotmigrations tests to prevent disconnections (#3703)": its changes miss the pull request's lines, which sit at 2095 to 2099, 2108 to 2112, 2120 to 2125 of its parent
- Ruling: 

## 36. fix linux profile detection for chromium users

- Case: clean/browser-use__browser-use-4512@67cff2e8 (evidence 119fcf402f2b)
- Change: https://github.com/browser-use/browser-use/pull/4512/files (8 changed lines in 2 files, Python)
- Commits: base 872ef3982dfbb8888588cddedecd341fbad34ead, head e44ce7ce732b9da9dd1c7e0916d8a4af7e0df6ba; merged 2026-03-24T22:28:34Z as https://github.com/browser-use/browser-use/commit/c8779d242db8394372ffd7e51f3f7ede7ca83ac1
- Licence: MIT, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-22T22:28:34Z (read 2026-10-12): 15 later commits on its files, each read line by line (11 reading as a fix, revert or follow-up), none touching its lines
- Later commits on browser_use/browser/session.py:
  - 2026-03-25T21:30:42Z https://github.com/browser-use/browser-use/commit/a2313d9665a58b7eda5fe032545249ef05aeae27 "Merge branch 'main' into feature/cdp-navigation-timeout": its first parent does not hold the pull request (a commit on another branch's line, or a merge into one)
  - 2026-03-25T23:34:25Z https://github.com/browser-use/browser-use/commit/4c883feb7c6f9d71600818b94e0f4a5359651362 "Merge branch 'main' into fix/cloud-session-stop-cdp-reconnect": its first parent does not hold the pull request (a commit on another branch's line, or a merge into one)
  - 2026-03-31T18:19:43Z https://github.com/browser-use/browser-use/commit/5e644981e82cc1276aca768b27df54155d9ddc3c "fix: close CloudBrowserClient httpx pool on session stop to prevent memory leak": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-04-09T05:05:50Z https://github.com/browser-use/browser-use/commit/76569995fd92db3bad968eb8244a31ceda5d161c "Improve OSS-to-cloud conversion: UTM tracking, better error messages, and cloud nudges": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-04-12T21:43:04Z https://github.com/browser-use/browser-use/commit/c1eb87a35fd7968bfcda91e522a9deb1ba714139 "close alias for BrowserSession stop": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-04-12T21:45:44Z https://github.com/browser-use/browser-use/commit/76604913ad0ca43cc4797da338a395a3e5ea9bb4 "Merge branch 'main' into fix/browser-session-close": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-04-21T00:40:32Z https://github.com/browser-use/browser-use/commit/9a09c4d7dc634a26bc9cf8a4e6d5695682d6f426 "fix(cdp): timeout-wrap CDPClient.send_raw to break silent WebSocket hangs": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-05-18T18:23:41Z https://github.com/browser-use/browser-use/commit/9a6510a85cf1df93e0dd1f6555fac12688d33e37 "fix: respect proxy_country_code=None to disable proxy in cloud mode": its changes miss the pull request's lines, which sit at 413 of its parent
- Later commits on browser_use/skill_cli/utils.py:
  - 2026-04-02T00:43:42Z https://github.com/browser-use/browser-use/commit/01995138f119e9795eabdf2c3e9bc3aa6777df3d "chore: remove dead code found by codex review": its changes miss the pull request's lines, which sit at 216 to 220 of its parent
  - 2026-04-02T00:56:39Z https://github.com/browser-use/browser-use/commit/e09f55eedc7c3f79ca2deec7efbd26f23de52517 "chore: remove more dead code (second codex pass)": its changes miss the pull request's lines, which sit at 170 to 174 of its parent
  - 2026-04-02T01:24:41Z https://github.com/browser-use/browser-use/commit/b92c7486bfe65bb5d14c2d2ab1edfaa8be141429 "fix: remove 9229 from Chrome CDP port probing (Node.js debugger port, not Chrome)": its changes miss the pull request's lines, which sit at 128 to 132 of its parent
  - 2026-04-03T00:41:15Z https://github.com/browser-use/browser-use/commit/a05a053da63498bb5a6865422f0e7cbe88175b71 "fix: add per-session auth token to daemon socket to prevent unauthorized code execution": its changes miss the pull request's lines, which sit at 128 to 132 of its parent
  - 2026-04-14T18:23:50Z https://github.com/browser-use/browser-use/commit/d0fbf4c5807a2904e19ac2c1468d2639189a8f26 "improve connect failure UX: fix chrome://inspect link and add fallback guidance": its changes miss the pull request's lines, which sit at 133 to 137 of its parent
  - 2026-04-15T17:07:51Z https://github.com/browser-use/browser-use/commit/4c2d136de9d22af9ab53e807f3064341b75d7687 "fix: add utf-8 encoding to Local State file read in list_chrome_profiles": its first parent does not hold the pull request (a commit on another branch's line, or a merge into one)
  - 2026-04-15T20:06:56Z https://github.com/browser-use/browser-use/commit/9c314e626ecf6f24c36903ceb3c161ae919e75f1 "Merge branch 'main' into fix/local-state-utf8-encoding": its first parent does not hold the pull request (a commit on another branch's line, or a merge into one)
- Ruling: 

## 37. dbeaver/dbeaver#40062 Fix autocomplete for fabric

- Case: clean/dbeaver__dbeaver-40414@1dbd0fbd (evidence 8596146d980d)
- Change: https://github.com/dbeaver/dbeaver/pull/40414/files (13 changed lines in 2 files, Java)
- Commits: base 33a443bc0e6151b948c9409b70e4d940381fd1c3, head dc04f9285bcac2a852231cd7110ba16d9d8112f7; merged 2026-02-23T17:26:03Z as https://github.com/dbeaver/dbeaver/commit/ca3fecf6db993e2a280f3a12900a1e9968a3ce8e
- Licence: Apache-2.0, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-24T17:26:03Z (read 2026-10-12): 3 later commits on its files, each read line by line (3 reading as a fix, revert or follow-up), none touching its lines
- Later commits on plugins/org.jkiss.dbeaver.ext.mssql/src/org/jkiss/dbeaver/ext/mssql/model/SQLServerDataSource.java:
  - 2026-03-26T09:20:59Z https://github.com/dbeaver/dbeaver/commit/a4c321f95958e6a5eb1ae8ac2eb5ed7aaf42af7f "#39960 Add detect SQL Server expired/must-change password errors and promp… (#40456)": its changes miss the pull request's lines, which sit at 152 of its parent
  - 2026-04-20T09:50:01Z https://github.com/dbeaver/dbeaver/commit/fb3ff4c1e9e76887269a3336d9e02191741cacbb "#39464 Fix force TOP injection for MSSQL table-valued function queries (#40772)": its changes miss the pull request's lines, which sit at 158 of its parent
  - 2026-04-21T10:22:43Z https://github.com/dbeaver/dbeaver/commit/5b604d6fde371cd5db2b175b945ed5a19e8e220b "dbeaver/pro#8166 Google BQ new driver (#40747)": its changes miss the pull request's lines, which sit at 159 of its parent
- Ruling: 

## 38. Fix ZDIFF algorithm 2 memory leak on early exit

- Case: clean/valkey-io__valkey-3342@29993a20 (evidence f5dcfa7a70c2)
- Change: https://github.com/valkey-io/valkey/pull/3342/files (13 changed lines in 2 files, C)
- Commits: base 5deebd0f131826124b3ab6231fafb5f9b188523b, head daa115a760d9cbb00bfac57b1ab3bd0af436e7d1; merged 2026-03-11T02:34:15Z as https://github.com/valkey-io/valkey/commit/6b384e9a5b6cd4e4f8198f5df22a74feb1b70e0f
- Licence: BSD-3-Clause, COPYING
- Reviews by others: 3 (approved 3); none requested changes
- Checked up to 2026-06-09T02:34:15Z (read 2026-10-12): 3 later commits on its files, each read line by line (2 reading as a fix, revert or follow-up), none touching its lines
- Later commits on src/t_zset.c:
  - 2026-03-11T11:26:44Z https://github.com/valkey-io/valkey/commit/6414720504f689a3fc699338bf22565bb70c3829 "Replace fast_float (C++) with ffc.h (#3329)": its changes miss the pull request's lines, which sit at 2510 to 2513 of its parent
  - 2026-04-02T10:09:06Z https://github.com/valkey-io/valkey/commit/fb655dbf5cfaf254e0b8bb6617f1f734dbebc07d "Replace dict with thin wrapper around hashtable (#3366)": its changes miss the pull request's lines, which sit at 2510 to 2513 of its parent
  - 2026-05-06T19:48:26Z https://github.com/valkey-io/valkey/commit/6c9d7fc263dd4dfe07460f7ed6de63295890b77a "CLUSTERSCAN range bounded scanning across contiguous slots (#3391)": its changes miss the pull request's lines, which sit at 2511 to 2514 of its parent
- Later commits naming it (quoting its title, or with no fix word): https://github.com/valkey-io/valkey/commit/27dd874834fd181f3517d0874cf2406da977ad60 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/6fd227f7a3306ac264a0aac427ab18cdf6ba7a17 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/614351040cab1b77532aec9fbf913f28ddda17f9 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/830d1fecb54d758869ef3f48efd3ff9e325ba2dc "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/4a3714ba93dd2dde3d6364ee6368672e04244518 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/7c33dca93ba13038ff10868ed5ba223b4ef09d54 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/e77aa946c4fe89bd17aee9b36be8576f890183c5 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/sarthakaggarwal97/valkey/pull/117 "[backport] Weekly backport sweep for 8.1"; https://github.com/sarthakaggarwal97/valkey/pull/234 "[backport] Weekly backport sweep for 7.2"; https://github.com/sarthakaggarwal97/valkey/pull/235 "[backport] Weekly backport sweep for 8.0"; https://github.com/valkey-io/valkey/pull/3735 "[backport][validation failed] Backport sweep for 9.0"; https://github.com/valkey-io/valkey/pull/3737 "[backport] Backport sweep for 8.1"; https://github.com/valkey-io/valkey/pull/3736 "[backport] Backport sweep for 8.0"; https://github.com/valkey-io/valkey/pull/3738 "[backport] Backport sweep for 7.2"; https://github.com/valkey-io/valkey/pull/3879 "[backport] Backport sweep for 9.0"; https://github.com/sarthakaggarwal97/valkey/pull/286 "[backport] Backport sweep for 7.2"
- Ruling: 

## 39. doc: minor typo fix

- Case: clean/nodejs__node-62358@5869d713 (evidence 119d4ef44656)
- Change: https://github.com/nodejs/node/pull/62358/files (6 changed lines in 1 file, JavaScript)
- Commits: base 7547e795ef700e1808702fc2851a0dcc3395a065, head 21bd03ed84e0d9b93421ae39775a9712e8f69972; merged 2026-03-22T21:48:58Z as https://github.com/nodejs/node/commit/61102cdbb3d59155ad5bb4fc9419627a31e63f7a
- Licence: NOASSERTION, LICENSE (unverified: used and published in full)
- Reviews by others: 9 (approved 7, commented 2); none requested changes
- Checked up to 2026-06-20T21:48:58Z (read 2026-10-12): 2 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on doc/api/vm.md:
  - 2026-05-10T15:06:35Z https://github.com/nodejs/node/commit/49aef0d3f5d10f7bde0b050c7fcb404271e2ebb4 "doc: remove unnecessary `<!-- eslint-` magic comments": its changes miss the pull request's lines, which sit at 1838, 1840 to 1841 of its parent
  - 2026-06-12T21:45:48Z https://github.com/nodejs/node/commit/20fda5692ef0b6a3af1ec8ecbe7e1fa9bad4e3d9 "doc: fix typo in vm.md": its changes miss the pull request's lines, which sit at 1834, 1836 to 1837 of its parent
- Later commits naming it (quoting its title, or with no fix word): https://github.com/nodejs/node/commit/b4182ac60b14996088537df2ee3584d8d9a29e54 "doc: minor typo fix"; https://github.com/nodejs/node/commit/013243617096e36d421cb29ea73b738e0ffa4060 "doc: minor typo fix"; https://github.com/nodejs/node/commit/ce998116990895c26daae1b88d96cf10ecf5712a "doc: minor typo fix"; https://github.com/nodejs/node/commit/75778c6dbe90d772d159f7fd8ab880d2ad3919ff "doc: minor typo fix"; https://github.com/nodejs/node/commit/47e199ae94a1008dffd6e3101bd9c58688dd3141 "doc: minor typo fix"; https://github.com/nodejs/node/commit/68f4ee165109d3cdd884254f665588a1eb0a7ad6 "doc: minor typo fix"; https://github.com/nodejs/node/commit/93d19b1a1cc0457914783c24f158e42996528e4d "doc: minor typo fix"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/nodejs/node/pull/62522 "2026-04-01, Version 25.9.0 (Current)"; https://github.com/nodejs/node/pull/62681 "2026-04-15, Version 24.15.0 'Krypton' (LTS)"
- Ruling: 

## 40. dbeaver/pro#8260 Add `SMTokenInfo` class and `readAccessTokenInfo` me…

- Case: clean/dbeaver__dbeaver-40558@dc4d7837 (evidence ca7757b916d9)
- Change: https://github.com/dbeaver/dbeaver/pull/40558/files (89 changed lines in 2 files, Java)
- Commits: base 07a18b4e21a9486768969388bb4163382f1be88f, head c165dc827ea3fa6407e77b2550d8db2157d2beb8; merged 2026-03-24T09:56:15Z as https://github.com/dbeaver/dbeaver/commit/83a960ceeb727a4ded2e34cf26b097140d6da2dc
- Licence: Apache-2.0, LICENSE.md
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-22T09:56:15Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 41. Starknet loopback client

- Case: clean/unionlabs__union-5384@a78ba723 (evidence 32b2f919380e)
- Change: https://github.com/unionlabs/union/pull/5384/files (552 changed lines in 9 files, Rust)
- Commits: base df020f8061bce193f651089c0ec776141a1a1e83, head 86cc328fe48bdbc6d76f430e06b006296cc34a42; merged 2026-01-15T09:16:36Z as https://github.com/unionlabs/union/commit/892e9f565c8f1a0c4638235518b0e3907e974b20
- Licence: Apache-2.0, LICENSE-APACHE
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-04-15T09:16:36Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on Scarb.toml:
  - 2026-01-15T09:42:20Z https://github.com/unionlabs/union/commit/004b56a36139bae15a92831c4018da04eb8fe687 "chore(starknet): check pairing result": its changes miss the pull request's lines, which sit at 3 to 8, 10 of its parent
- Ruling: 

## 42. ci(cypress): fix payload and airwallex tests

- Case: clean/juspay__hyperswitch-11561@7cb5be1e (evidence 809ff3ff4d53)
- Change: https://github.com/juspay/hyperswitch/pull/11561/files (28 changed lines in 2 files, Rust)
- Commits: base 7833f99045683985f84bd566f2ac3347facc3fde, head 7ef403ab03fb414501219aa8dffbeaa62e4d8634; merged 2026-03-23T11:31:05Z as https://github.com/juspay/hyperswitch/commit/80e8d4e00657f27f5c1cb3f16a218a5165452968
- Licence: Apache-2.0, LICENSE
- Reviews by others: 5 (approved 2, commented 1, dismissed 2); none requested changes
- Checked up to 2026-06-21T11:31:05Z (read 2026-10-12): 7 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on cypress-tests/cypress/e2e/configs/Payment/Airwallex.js:
  - 2026-03-31T13:50:35Z https://github.com/juspay/hyperswitch/commit/5aa2452ca212050f9ae47b35b5042e8ae5a19894 "ci(cypress): added payment webhook fixtures (#11612)": its changes miss the pull request's lines, which sit at 518 of its parent
  - 2026-04-10T19:48:36Z https://github.com/juspay/hyperswitch/commit/2ef119e5c28402365e43a0288de092f6eaa9e917 "ci(cypress): added refund webhooks for supported connectors (#11754)": its changes miss the pull request's lines, which sit at 518 of its parent
  - 2026-05-03T10:54:47Z https://github.com/juspay/hyperswitch/commit/94bf523b6f771b1b9e7c3033f57a6ebbcb17e1ce "test(cypress): add ConnectorMetadata testcases for noon, airwallex, braintree (#12079)": its changes miss the pull request's lines, which sit at 518 of its parent
  - 2026-05-09T12:15:11Z https://github.com/juspay/hyperswitch/commit/6ac0cd81db0d998fed381fb9507ff3ae5cf74a1c "test(cypress): Add pay_later_pm configs for Airwallex and Mollie (#12183)": its changes miss the pull request's lines, which sit at 518 of its parent
  - 2026-06-03T12:16:21Z https://github.com/juspay/hyperswitch/commit/d91290241278c1ff0bb8007f2ac9904b850ae45a "test(cypress): add airwallex alternative payment coverage for paylater, and wallet (#12370)": its changes miss the pull request's lines, which sit at 519 of its parent
- Later commits on cypress-tests/cypress/e2e/configs/Payment/Payload.js:
  - 2026-03-31T13:50:35Z https://github.com/juspay/hyperswitch/commit/5aa2452ca212050f9ae47b35b5042e8ae5a19894 "ci(cypress): added payment webhook fixtures (#11612)": its changes miss the pull request's lines, which sit at 22 to 23, 160, 185, 193 to 195, 292, 362, 465, 653 of its parent
  - 2026-05-12T09:46:21Z https://github.com/juspay/hyperswitch/commit/53989bba6067f3d1a35840c46776437f29aa16ef "test(cypress): add bank debit ACH coverage for payload connector (#12253)": its changes miss the pull request's lines, which sit at 22 to 23, 160, 185, 193 to 195, 292, 362, 465, 653 of its parent
- Ruling: 

## 43. fix(core): Add format validation to source control branch name

- Case: clean/n8n-io__n8n-27518@be2e1eb8 (evidence 9598e8fc5814)
- Change: https://github.com/n8n-io/n8n/pull/27518/files (25 changed lines in 2 files, TypeScript)
- Commits: base fc0f0712d8ee07cc259c9757cde44df8da2efe26, head 4f8dd78c8b69a0cba02bdd5b2b73bbccb358b80d; merged 2026-03-25T08:24:38Z as https://github.com/n8n-io/n8n/commit/fb7788d6c286f99126371a33b648c6def9541143
- Licence: NOASSERTION, LICENSE.md (unverified: used and published in full)
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-23T08:24:38Z (read 2026-10-12): 1 later commit on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on packages/cli/src/modules/source-control.ee/__tests__/source-control-preferences.service.ee.test.ts:
  - 2026-04-28T09:24:01Z https://github.com/n8n-io/n8n/commit/258b9703c5e07ac164bc47a7bb6e758888caf97b "refactor: Migrate all cipher call sites to encryptV2/decryptV2 (#29096)": its changes miss the pull request's lines, which sit at 43 to 62 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/n8n-io/n8n/pull/27765 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27771 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27772 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27778 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27781 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27786 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27787 ":rocket: Release 2.15.0"; https://github.com/ATHEO-Ingenierie/n8n-helm/pull/32 "Update n8n appVersion to 2.15.0"
- Ruling: 

## 44. Create LTS pkg and non-LTS pkg for macOS for LTS releases

- Case: clean/PowerShell__PowerShell-27039@d7b9ca6b (evidence 67ff71ceff9b)
- Change: https://github.com/PowerShell/PowerShell/pull/27039/files (13 changed lines in 1 file, C#)
- Commits: base 1f8bbe1e5332bb8fe1b39c81c366ddadbf9dd1a2, head b0f291545353eaa900dcd37c887758762dda3596; merged 2026-03-16T19:40:27Z as https://github.com/PowerShell/PowerShell/commit/8c9c9e11872c8d98c2e7d7a1ed991fc7e1d07354
- Licence: MIT, LICENSE.txt
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-14T19:40:27Z (read 2026-10-12): 3 later commits on its files, each read line by line (1 reading as a fix, revert or follow-up), none touching its lines
- Later commits on .pipelines/templates/mac-package-build.yml:
  - 2026-05-01T20:51:55Z https://github.com/PowerShell/PowerShell/commit/da95729be5a451575ad6c8dbec6d29ee0dcc1ebc "Add macOS binary code signing and package notarization": its changes miss the pull request's lines, which sit at 105 to 108, 127, 134 to 139 of its parent
  - 2026-05-05T19:47:42Z https://github.com/PowerShell/PowerShell/commit/3d13188032c3784ecbf7a9cb6111aefe6bf7ba61 "Fix executable permissions for pwsh and createdump": its changes miss the pull request's lines, which sit at 113 to 116, 135, 142 to 147 of its parent
  - 2026-05-05T19:47:42Z https://github.com/PowerShell/PowerShell/commit/d49ade659720172dcb2276bd46d59df29585bea2 "Move ESRP key codes into the `certificate_logical_to_actual` variable group": its changes miss the pull request's lines, which sit at 113 to 116, 135, 142 to 147 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/PowerShell/PowerShell/pull/27040 "[release/v7.6] Create LTS pkg and non-LTS pkg for macOS for LTS releases"; https://github.com/PowerShell/PowerShell/pull/27162 "[release/v7.5.6] Create LTS pkg and non-LTS pkg for macOS for LTS releases"
- Ruling: 

## 45. doc: clarify confusing `git range-diff` add/delete output

- Case: clean/bitcoin__bitcoin-34656@107d85ce (evidence 58d9fded9bbb)
- Change: https://github.com/bitcoin/bitcoin/pull/34656/files (13 changed lines in 1 file, C++)
- Commits: base ab8a7af74209e5d58203af14d9133d14de6a5776, head 45133c589a970390bc10e4db4f7d9921dbaa0832; merged 2026-02-27T10:21:45Z as https://github.com/bitcoin/bitcoin/commit/3c7b0f97e0f6384824ec387861a2e88dc4cd737a
- Licence: MIT, COPYING
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-05-28T10:21:45Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 46. Improve XML docs for OpenApiDocumentTransformerContext and ApiDescriptionGroup

- Case: clean/dotnet__aspnetcore-65786@b409403e (evidence 06ef11f855f0)
- Change: https://github.com/dotnet/aspnetcore/pull/65786/files (70 changed lines in 2 files, C#)
- Commits: base 6b10dacaefce56e6bf9b54c6eb06fa0b50f5b0c7, head c69ad3986e6a58403931af3c0a1a2f9e4c063bad; merged 2026-03-29T02:16:03Z as https://github.com/dotnet/aspnetcore/commit/f8a4c899e4fcecd0fe720b410446b9ea4c1a0da7
- Licence: MIT, LICENSE.txt
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-27T02:16:03Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits naming it (quoting its title, or with no fix word): https://github.com/dotnet/aspnetcore/commit/722124cafd1f7dc8abf3468119e6514a4e677733 "Improve XML docs for OpenApiDocumentTransformerContext and ApiDescriptionGroup (#65786)"
- Ruling: 

## 47. fix(mobile): mismatch between system and app color when using low-chroma system color scheme

- Case: clean/immich-app__immich-27282@3e94b6c2 (evidence e958de53e45a)
- Change: https://github.com/immich-app/immich/pull/27282/files (12 changed lines in 1 file, TypeScript)
- Commits: base e2d26ebdea86c8157017602b64fc4019fb24c842, head 51ce41f373f41d6bce0eb9aa8d53e0eae33d9a82; merged 2026-03-27T14:21:44Z as https://github.com/immich-app/immich/commit/be0fc403d807bca0556e46d18193ca5e7e72de39
- Licence: AGPL-3.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-25T14:21:44Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Ruling: 

## 48. Update geoip-processor.md

- Case: clean/elastic__elasticsearch-145087@f8bc183c (evidence eef2ca66d951)
- Change: https://github.com/elastic/elasticsearch/pull/145087/files (5 changed lines in 1 file, Java)
- Commits: base b909c6cf7e752f01854de416b242deb719e17a1d, head 3cec09c4b94db97df1f549120b5b3c36eea57b24; merged 2026-03-27T14:07:22Z as https://github.com/elastic/elasticsearch/commit/19728c5eae3bb55c81242a438efcc79a43dc0b9b
- Licence: NOASSERTION, LICENSE.txt (unverified: used and published in full)
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-25T14:07:22Z (read 2026-10-12): 2 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits on docs/reference/enrich-processor/geoip-processor.md:
  - 2026-04-23T17:09:29Z https://github.com/elastic/elasticsearch/commit/f15498898c8a557b96152f977fdceaec9c2963b7 "docs: Update domain list for geoip.elastic.co (#146396)": its changes miss the pull request's lines, which sit at 249 to 251 of its parent
  - 2026-06-25T10:57:02Z https://github.com/elastic/elasticsearch/commit/f921660b0eb93c703f4a0e94892db3790710c52a "[Docs] Deduplicate  pages in the plugins section (#151983)": its changes miss the pull request's lines, which sit at 250 to 252 of its parent
- Ruling: 

## 49. tools: keep GN files when updating Merve

- Case: clean/nodejs__node-62167@24cf8219 (evidence 5a25061e4dd7)
- Change: https://github.com/nodejs/node/pull/62167/files (4 changed lines in 1 file, JavaScript)
- Commits: base 70b35704a04be477e60755bf075d617976925fef, head 07b43ce6f922f4ebff49c265a7c5a309684bd294; merged 2026-03-11T14:15:25Z as https://github.com/nodejs/node/commit/2b74812c3ca2fdb466fd64d44e9c0cfbf2637b00
- Licence: NOASSERTION, LICENSE (unverified: used and published in full)
- Reviews by others: 4 (approved 4); none requested changes
- Checked up to 2026-06-09T14:15:25Z (read 2026-10-12): 0 later commits on its files, each read line by line (0 reading as a fix, revert or follow-up), none touching its lines
- Later commits naming it (quoting its title, or with no fix word): https://github.com/nodejs/node/commit/1aad512f947ef33ceaee317e6b52f7184896695e "tools: keep GN files when updating Merve"; https://github.com/nodejs/node/commit/7d9db8cd212be8c008279d822e567542938b423c "tools: keep GN files when updating Merve"; https://github.com/nodejs/node/commit/135e8c853cc77e3aca4d2646a22f83d29e462e90 "tools: keep GN files when updating Merve"; https://github.com/nodejs/node/commit/9708f7754e9fa715389d8380b29ec9eb6d77c427 "tools: keep GN files when updating Merve"; https://github.com/nodejs/node/commit/3d0f97e21aaca29de407a90a5ff30b6089f67c08 "tools: keep GN files when updating Merve"; https://github.com/nodejs/node/commit/b771d1e225e06bc986115aedb9c2b144ddb4dcda "tools: keep GN files when updating Merve"; https://github.com/nodejs/node/commit/795d663ff42ff1ad82b83588771567c7b2a7c39a "tools: keep GN files when updating Merve"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/nodejs/node/pull/62522 "2026-04-01, Version 25.9.0 (Current)"; https://github.com/nodejs/node/pull/62681 "2026-04-15, Version 24.15.0 'Krypton' (LTS)"
- Ruling: 

