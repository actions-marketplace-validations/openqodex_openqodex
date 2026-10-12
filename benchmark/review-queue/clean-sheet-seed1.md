# Clean controls: candidates to rule

Sheet clean@1: 65 pull requests in a shuffled order (seed 1). A script found each merged, reviewed with no request for changes, and with no later fix, revert, fix-up or bug report it can see touching it; the evidence it read is under each. No reviewer has seen these changes. Read the change itself (the Files tab of its link) and rule whether it is free of any issue a reviewer should raise. Record each ruling under your own name:

```
node benchmark/queue.mjs decide clean <case id> --by <your name> --sheet clean@1
node benchmark/queue.mjs decide not-clean <case id> --by <your name> --sheet clean@1 --note "<the issue>"
node benchmark/ingest/clean.mjs admit
```

## 1. Accept changes solely due to _jsxFileName

- Case: clean/microsoft__typescript-go-3186@3d538b77
- Change: https://github.com/microsoft/typescript-go/pull/3186/files (20 changed lines in 17 files, Go)
- Commits: base a4325da30f285ff85b7b55afe1c65d74f54794af, head 00b71c32a05c83e584e071b148854e28fd67f8c3; merged 2026-03-24T20:35:22Z as https://github.com/microsoft/typescript-go/commit/35a210b62187cec05270cb2641cece25ca9ac7b5
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-22T20:35:22Z (read 2026-10-12): 51 later commits on its files, 11 reading as a fix, revert or follow-up, none touching its lines
- Later commits on testdata/submoduleAccepted.txt: 51, 40 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-16T22:32:19Z https://github.com/microsoft/typescript-go/commit/f4dee45136dca89562ca05d2e82423a588753bf5 "Fix export default dts widening (#3352)": its changes miss the pull request's lines, which sit at 213 to 231 of its parent
  - 2026-04-23T17:25:42Z https://github.com/microsoft/typescript-go/commit/911ba0b2c6be4d7389ed798314f26d17ca963546 "Fix error propagation through non-iterable unions (#3496)": its changes miss the pull request's lines, which sit at 193 to 211 of its parent
  - 2026-04-23T17:58:17Z https://github.com/microsoft/typescript-go/commit/fd9bbdb53aeca0b6f18afbc9fdaf9755a736b18f "Fix `maybeMappedType` function (#3529)": its changes miss the pull request's lines, which sit at 193 to 211 of its parent
  - 2026-04-30T21:43:21Z https://github.com/microsoft/typescript-go/commit/25963e42b8a5d7da694c6ee555fed3cc93de1e71 "Fix checks for disallowed property/accessor duplicate declarations (#3672)": its changes miss the pull request's lines, which sit at 193 to 194, 198 to 214 of its parent
  - 2026-05-08T20:40:51Z https://github.com/microsoft/typescript-go/commit/e1f8f977a8f7c5284fb9bba22efdeaf620151a13 "Fix package index fallback edge case, accept self-name resolution errors under ambiguous project root (#3776)": its changes miss the pull request's lines, which sit at 193 to 194, 198 to 214 of its parent
  - 2026-05-12T00:15:34Z https://github.com/microsoft/typescript-go/commit/adb2ab4ed7d7849bb222eb27c41437d5520335a9 "Fix declaration emit renaming a method's shadowed type parameter to the outer generic (#3761)": its changes miss the pull request's lines, which sit at 193 to 194, 198 to 214 of its parent
  - 2026-05-12T21:04:51Z https://github.com/microsoft/typescript-go/commit/3e909a10cafce78d1d201e17107006d5f46809de "Add fixed copy of self name declaration emit test, accept baselines otherwise (#3820)": its changes miss the pull request's lines, which sit at 193 to 194, 198 to 214 of its parent
  - 2026-05-15T18:22:32Z https://github.com/microsoft/typescript-go/commit/3d2b68080edbdd170b715c66b313a7875726071b "feat(2280): Port implement interface quick fix (#3499)": its changes miss the pull request's lines, which sit at 193 to 194, 198 to 214 of its parent
  - 2026-05-26T22:28:55Z https://github.com/microsoft/typescript-go/commit/c54ff7cc5528734fd303461719b54b70115f5445 "fix(4048): fix declaration emit for new keyword used as property names (#4052)": its changes miss the pull request's lines, which sit at 193 to 194, 198 to 214 of its parent
  - 2026-06-10T18:28:25Z https://github.com/microsoft/typescript-go/commit/7fc57c0050639e01409766f41a77a10d03106297 "Fix a slew of UTF-8/UTF-16 related issues (#4181)": its changes miss the pull request's lines, which sit at 192 to 193, 197 to 213 of its parent
  - 2026-06-15T17:19:58Z https://github.com/microsoft/typescript-go/commit/b8e44908979c85b2c5a31eff6aa5bac38f4f2f4b "Fixed CJS class expression exports emit anonymous constructor types (#3850)": its changes miss the pull request's lines, which sit at 198 to 199, 203 to 219 of its parent
- Ruling: 

## 2. fix double count result rows

- Case: clean/ClickHouse__ClickHouse-101226@b13a682a
- Change: https://github.com/ClickHouse/ClickHouse/pull/101226/files (87 changed lines in 4 files, C++)
- Commits: base b0843fd08e610a0d296075df0b184288f9249dd3, head ce64063d127f0d730a5a72493ad29e3a7619b53a; merged 2026-03-31T08:37:08Z as https://github.com/ClickHouse/ClickHouse/commit/5d45309b32c52f1b8fb52d6bd3df504006ec9533
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-29T08:37:08Z (read 2026-10-12): 3 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/Processors/Sources/WaitForAsyncInsertSource.h: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits naming it (quoting its title, or with no fix word): https://github.com/ClickHouse/ClickHouse/commit/651b9194d76ca0b2c5e4132985b8bfb061375700 "Backport #101226 to 26.2: fix double count result rows"; https://github.com/ClickHouse/ClickHouse/commit/d87b024170deeddee4e58cedfd15d8e645dbf5d2 "Backport #101226 to 26.3: fix double count result rows"; https://github.com/ClickHouse/ClickHouse/commit/cd9080200058458498f5398cb7437a9884984c9f "Merge pull request #101339 from ClickHouse/backport/26.2/101226"; https://github.com/ClickHouse/ClickHouse/commit/b94b45543608df3be80c43c91a0e027c7449ff56 "Merge pull request #101341 from ClickHouse/backport/26.3/101226"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/ClickHouse/ClickHouse/pull/101338 "Cherry pick #101226 to 26.2: fix double count result rows"; https://github.com/ClickHouse/ClickHouse/pull/101339 "Backport #101226 to 26.2: fix double count result rows"; https://github.com/ClickHouse/ClickHouse/pull/101340 "Cherry pick #101226 to 26.3: fix double count result rows"; https://github.com/ClickHouse/ClickHouse/pull/101341 "Backport #101226 to 26.3: fix double count result rows"
- Ruling: 

## 3. [frontport] Add Prometheus counter for validator notification subscription errors (#5641)

- Case: clean/linera-io__linera-protocol-5834@3bcfd126
- Change: https://github.com/linera-io/linera-protocol/pull/5834/files (23 changed lines in 1 file, Rust)
- Commits: base 5c58f960b3e62665d91e374a7b0f8e3ebf916006, head a5ec1b7b479d0194545bcbb326117a16e7d5209d; merged 2026-03-30T18:19:30Z as https://github.com/linera-io/linera-protocol/commit/8ff219c913a555fae091f4d417a68f9db4a59b63
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T18:19:30Z (read 2026-10-12): 11 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on linera-rpc/src/grpc/client.rs: 11, 11 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/linera-io/linera-protocol/pull/5889 "[frontport] Circuit breaker for validator notification streams (#5717)"
- Ruling: 

## 4. [ROCm][CI] Fix AITER state leak in shared_fused_moe_routed_transform test

- Case: clean/vllm-project__vllm-38137@fdf5dce0
- Change: https://github.com/vllm-project/vllm/pull/38137/files (24 changed lines in 3 files, Python)
- Commits: base bf5eec638d7571f0b88ea48a3d13709322b19a0c, head 05a4561825155d9a33dbec66e7e6cf0d962591e0; merged 2026-03-26T16:26:47Z as https://github.com/vllm-project/vllm/commit/bdc1719eb9b27ef4a30c1f753b406bf05c8edd3a
- Licence: Apache-2.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-24T16:26:47Z (read 2026-10-12): 14 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on tests/kernels/moe/test_shared_fused_moe_routed_transform.py: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on vllm/distributed/parallel_state.py: 11, 10 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-20T09:21:12Z https://github.com/vllm-project/vllm/commit/2aab9acf48b5f10a4ee0b29f152fc497a46c956d "[CPU][BugFix] Fix inter-node pipeline parallel (#40150)": its changes miss the pull request's lines, which sit at 1905 to 1915 of its parent
- Ruling: 

## 5. [API Nodes] made Reve node price badges more precise

- Case: clean/Comfy-Org__ComfyUI-13154@b2ed02b9
- Change: https://github.com/Comfy-Org/ComfyUI/pull/13154/files (43 changed lines in 1 file, Python)
- Commits: base b53b10ea61ef7fc54fbde7c1e7b7c36565bacf82, head f291cec5d28730f62e9c584b4734e0189ab743a4; merged 2026-03-25T18:05:50Z as https://github.com/Comfy-Org/ComfyUI/commit/a55835f10c29c1acdc9158bf9e092656ae1a2188
- Licence: GPL-3.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-23T18:05:50Z (read 2026-10-12): 2 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on comfy_api_nodes/nodes_reve.py: 2, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-06-02T04:24:46Z https://github.com/Comfy-Org/ComfyUI/commit/e88a81d316205bf3c3f9293778b78f5949e82e97 "Revert partner nodes category (#14229)": its changes miss the pull request's lines, which sit at 148 to 161, 241, 245, 247 to 255, 351, 355, 357 to 365 of its parent
- Ruling: 

## 6. Rename search hits

- Case: clean/elastic__elasticsearch-145252@a2c9e075
- Change: https://github.com/elastic/elasticsearch/pull/145252/files (4 changed lines in 1 file, Java)
- Commits: base 8d0f31d7ffd44514a8bb4367bc2aafee8c3bdd09, head 7f1cc1b0320bb3c071befa5ac24942898bd18d3e; merged 2026-03-31T17:51:18Z as https://github.com/elastic/elasticsearch/commit/7ec12824b2ec23d2942f874048682ee9fc6ce823
- Licence: NOASSERTION, LICENSE.txt (unverified: private runs only)
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-29T17:51:18Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

## 7. various: fix `Wdiscarded-qualifiers` warnings

- Case: clean/mpv-player__mpv-17582@7d43f4ea
- Change: https://github.com/mpv-player/mpv/pull/17582/files (56 changed lines in 12 files, C)
- Commits: base afef9126ce5a2c3fdb733318a754b3210f71fca9, head 0a9b451080b8c9e916f3fcb1756a8ff5bdf46f74; merged 2026-03-15T13:49:00Z as https://github.com/mpv-player/mpv/commit/8ace278cbea63f74863d242a991474e12fab3730
- Licence: NOASSERTION, LICENSE.GPL (unverified: private runs only)
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-13T13:49:00Z (read 2026-10-12): 46 later commits on its files, 5 reading as a fix, revert or follow-up, none touching its lines
- Later commits on options/m_property.c: 6, 6 with no fix word (listed in suites/clean/candidates.json)
- Later commits on options/m_property.h: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Later commits on player/command.c: 26, 22 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-01T22:05:27Z https://github.com/mpv-player/mpv/commit/4e6196e1a627c5becd3d1e831bd3d3aa6541e972 "player/command: fix update-clipboard text-primary": its changes miss the pull request's lines, which sit at 1317, 1387, 2150, 2288, 3533, 3537, 3902, 4185 of its parent
  - 2026-04-06T16:28:04Z https://github.com/mpv-player/mpv/commit/e0fe1a45d2685cd2ec3d30c00064d51ac9d35225 "command: fix race in reading pad_buttons_pressed": its changes miss the pull request's lines, which sit at 1310, 1380, 2157, 2295, 3548, 3552, 3925, 4208 of its parent
  - 2026-04-17T16:30:43Z https://github.com/mpv-player/mpv/commit/85bdf63a484360e4d53a2c719f4c82553352cb0d "player/command: simplify and fix new-line handling": its changes miss the pull request's lines, which sit at 1310, 1380, 2157, 2295, 3548, 3552, 3925, 4208 of its parent
  - 2026-04-18T19:13:46Z https://github.com/mpv-player/mpv/commit/bceb1eeaf49eb98d208a97e1308804f91ef7a6f1 "Revert "player/command: don't send mouse move event on mouse leave request"": its changes miss the pull request's lines, which sit at 1321, 1395, 2172, 2327, 3585, 3589, 3962, 4245 of its parent
- Later commits on player/configfiles.c: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on player/screenshot.c: 3, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-06T16:30:10Z https://github.com/mpv-player/mpv/commit/dfef53f94b8c80d81d15e3920f18433b8cd3b284 "player/screenshot: fix null dereference when failing to get time": its changes miss the pull request's lines, which sit at 171 of its parent
- Later commits on player/scripting.c: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on stream/stream.c: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later commits on stream/stream.h: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 8. test: update WPT for WebCryptoAPI to 2cb332d710

- Case: clean/nodejs__node-62483@9b57252c
- Change: https://github.com/nodejs/node/pull/62483/files (76 changed lines in 3 files, JavaScript)
- Commits: base cc967413c9b32e4d34d74a3b758ca71bee7a7746, head 7f4ee5f9c7f39c5b89f632ca51bc737c8ac6ff5e; merged 2026-03-31T00:57:06Z as https://github.com/nodejs/node/commit/404c3f9620e1cdf36df5d9d62f6fe77c63c1b683
- Licence: NOASSERTION, LICENSE (unverified: private runs only)
- Reviews by others: 4 (approved 4); none requested changes
- Checked up to 2026-06-29T00:57:06Z (read 2026-10-12): 29 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on test/fixtures/wpt/README.md: 15, 15 with no fix word (listed in suites/clean/candidates.json)
- Later commits on test/fixtures/wpt/versions.json: 14, 14 with no fix word (listed in suites/clean/candidates.json)
- Later commits naming it (quoting its title, or with no fix word): https://github.com/nodejs/node/commit/3796a73719b507a3d3d9f00ae8c3ef17ed6cc190 "test: update WPT for WebCryptoAPI to 2cb332d710"; https://github.com/nodejs/node/commit/cfd843d65f3bdb984456b4cca8dfc3f78821df85 "test: update WPT for WebCryptoAPI to 2cb332d710"; https://github.com/nodejs/node/commit/5ed5474437e1ade1bc0c3042634ed85dc61d88a7 "test: update WPT for WebCryptoAPI to 2cb332d710"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/nodejs/node/pull/62522 "2026-04-01, Version 25.9.0 (Current)"; https://github.com/nodejs/node/pull/62681 "2026-04-15, Version 24.15.0 'Krypton' (LTS)"
- Ruling: 

## 9. ci: migrate dependency-submission.yml from GH check to GH CI

- Case: clean/kestra-io__kestra-15139@da313bf5
- Change: https://github.com/kestra-io/kestra/pull/15139/files (22 changed lines in 1 file, Java)
- Commits: base 99617827ef127c379b47a1a0038d03829f41c755, head 4fafc5a0a4d0a4b250debe2d0b42b4c5e5ff6521; merged 2026-03-18T12:56:09Z as https://github.com/kestra-io/kestra/commit/7a4d741059b93306636ed9b33cc667cb2cfbb367
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-16T12:56:09Z (read 2026-10-12): 3 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on .github/workflows/dependency-submission.yml: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 10. [Fix] handle PaddleOCR-VL image processor max_pixels across Transformers v4/v5

- Case: clean/vllm-project__vllm-38629@4c174ead
- Change: https://github.com/vllm-project/vllm/pull/38629/files (8 changed lines in 1 file, Python)
- Commits: base 719735d6c5f5dae14948c2150e6858351994b0b9, head 5fb284979680b983472bafe07481bda7ca01c8c8; merged 2026-03-31T15:50:41Z as https://github.com/vllm-project/vllm/commit/b6e636c12c28c9ae83e22c65b4fca64a5571483b
- Licence: Apache-2.0, LICENSE
- Reviews by others: 5 (approved 1, commented 4); none requested changes
- Checked up to 2026-06-29T15:50:41Z (read 2026-10-12): 3 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on vllm/model_executor/models/paddleocr_vl.py: 3, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-05-11T09:04:06Z https://github.com/vllm-project/vllm/commit/9efdddca283cc0eb7c37fa49c4a9d1c9bf59ec4e "[Model] Fix missing `maybe_prefix` (#42280)": its changes miss the pull request's lines, which sit at 203 to 209 of its parent
- Ruling: 

## 11. Update README.

- Case: clean/Comfy-Org__ComfyUI-12931@de258265
- Change: https://github.com/Comfy-Org/ComfyUI/pull/12931/files (11 changed lines in 1 file, Python)
- Commits: base 7810f49702eac6e617eb7f2c30b00a8939ef1404, head 0f405efcc3d9267cfb9380c72de65abca9a8f736; merged 2026-03-14T02:33:28Z as https://github.com/Comfy-Org/ComfyUI/commit/16cd8d8a8f5f16ce7e5f929fdba9f783990254ea
- Licence: GPL-3.0, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-12T02:33:28Z (read 2026-10-12): 13 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on README.md: 13, 12 with no fix word (listed in suites/clean/candidates.json)
  - 2026-05-24T02:48:31Z https://github.com/Comfy-Org/ComfyUI/commit/32a7092c52d2cee053fded50a6e12c7e275b195e "fix: correct description of where compiled FE files live (#14013)": its changes miss the pull request's lines, which sit at 47 to 48, 60 to 66 of its parent
- Ruling: 

## 12. fix(span): prevent false ellipsis when text fits within container width

- Case: clean/lvgl__lvgl-9833@7af22eca
- Change: https://github.com/lvgl/lvgl/pull/9833/files (92 changed lines in 6 files, C)
- Commits: base 2c888ecd32375fe493b90d68161339a0e61c7b5b, head 2c05ee14b210b98133b116be04cf48716f1cd31e; merged 2026-03-11T09:32:33Z as https://github.com/lvgl/lvgl/commit/f23f2806f83f724ebfe1f4ff5fa69bdcad11236f
- Licence: MIT, LICENCE.txt
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-09T09:32:33Z (read 2026-10-12): 3 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/widgets/span/lv_span.c: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 13. Update azure/msal-browser

- Case: clean/dotnet__aspnetcore-66055@d797025b
- Change: https://github.com/dotnet/aspnetcore/pull/66055/files (25 changed lines in 3 files, C#)
- Commits: base 6b10dacaefce56e6bf9b54c6eb06fa0b50f5b0c7, head 0a9b270acd140a1c17466b42c34969b068b2c389; merged 2026-03-31T03:20:25Z as https://github.com/dotnet/aspnetcore/commit/c1a3e7b0f3a45cf91064f4fa4ebf1801f5efd58f
- Licence: MIT, LICENSE.txt
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-29T03:20:25Z (read 2026-10-12): 4 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on package-lock.json: 4, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-08T21:54:26Z https://github.com/dotnet/aspnetcore/commit/840e41c70b04d2e311cd7ad537bbab096a47109e "Fix lodash CVE by adding npm override for >=4.18.0 (#66222)": its changes miss the pull request's lines, which sit at 42 to 44, 47, 54 to 56, 18758 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/dotnet/dotnet/pull/5821 "[main] Source code updates from dotnet/aspnetcore"; https://github.com/dotnet/aspnetcore/pull/66094 "[release/10.0] Update azure/msal-browser"; https://github.com/dotnet/aspnetcore/pull/66234 "[release/9.0] Update azure/msal-browser"
- Ruling: 

## 14. fix(core): sort and filter ForEachItem merge outputs for consistent ordering

- Case: clean/kestra-io__kestra-15204@ca18eaa0
- Change: https://github.com/kestra-io/kestra/pull/15204/files (5 changed lines in 1 file, Java)
- Commits: base 72818bba99ecc25df8bc59895c436c329617f268, head 9c770ce607b15593093a7942c728c68e584fa89a; merged 2026-03-24T12:57:11Z as https://github.com/kestra-io/kestra/commit/bcd261857c4502be806875de266e26c198e54832
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-22T12:57:11Z (read 2026-10-12): 4 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on core/src/main/java/io/kestra/plugin/core/flow/ForEachItem.java: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 15. fix(cli): show helpful guidance when no skills are available

- Case: clean/google-gemini__gemini-cli-23785@af58ed3a
- Change: https://github.com/google-gemini/gemini-cli/pull/23785/files (19 changed lines in 3 files, TypeScript)
- Commits: base 3ada29fb519d984b197bc597f0e45b739dd43e37, head 53c57d012891a981bd0d5634a33897a28ce9055f; merged 2026-03-25T22:21:51Z as https://github.com/google-gemini/gemini-cli/commit/8595b07f6da433f04f75fc2f8616c45b89e63899
- Licence: Apache-2.0, LICENSE
- Reviews by others: 4 (approved 1, commented 3); none requested changes
- Checked up to 2026-06-23T22:21:51Z (read 2026-10-12): 2 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on packages/cli/src/ui/constants.ts: 2, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-01T16:09:30Z https://github.com/google-gemini/gemini-cli/commit/7d1848d578b644c274fcd1f6d03685aafc19e8ed "fix(cli): cap shell output at 10 MB to prevent RangeError crash (#24168)": its changes miss the pull request's lines, which sit at 61 to 64 of its parent
- Ruling: 

## 16. [4.x] Feat: add new tailwindcss colors

- Case: clean/filamentphp__filament-19304@4e85e247
- Change: https://github.com/filamentphp/filament/pull/19304/files (62 changed lines in 1 file, PHP)
- Commits: base cdcf753675f0675c239c76c018e44b9f61d2a46e, head 7a48ed0ea16167238758214161cf82afc8dd5f9b; merged 2026-02-28T18:14:20Z as https://github.com/filamentphp/filament/commit/4a1246512e552cec69f545118e4e35b87a5a6813
- Licence: MIT, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-29T18:14:20Z (read 2026-10-12): 2 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on packages/support/src/Colors/Color.php: 2, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-13T09:03:18Z https://github.com/filamentphp/filament/commit/aa82febcd584e02024a8fc3b053f71f58360d48a "Fix avatar background color of ui-avatars provider (#19664)": its changes miss the pull request's lines, which sit at 77 to 132, 445, 610 to 613 of its parent
- Ruling: 

## 17. Set synthesized array literal's parent in malformed JSON files

- Case: clean/microsoft__typescript-go-3166@80c9f8be
- Change: https://github.com/microsoft/typescript-go/pull/3166/files (66 changed lines in 6 files, Go)
- Commits: base 3ec52c7052f9cb8b62d8ee62c98f4d6f47010168, head 2a6479e865e6c0f9ab4560a15590eee76dbbf1e1; merged 2026-03-19T20:42:36Z as https://github.com/microsoft/typescript-go/commit/acdd67ef35f63cac4d2eeb837d4e18a5b8ffc2d3
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-17T20:42:36Z (read 2026-10-12): 16 later commits on its files, 6 reading as a fix, revert or follow-up, none touching its lines
- Later commits on internal/parser/parser.go: 16, 10 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-31T17:23:43Z https://github.com/microsoft/typescript-go/commit/235ae15b957ff4e6821ae4e83cd6041e56708d03 "Fix JSX parsing failures in ternary expressions with nested JSX attributes (#2937)": its changes miss the pull request's lines, which sit at 202 of its parent
  - 2026-05-15T18:59:05Z https://github.com/microsoft/typescript-go/commit/e5a356e25b3d96c3acdcb5a70b848ce5fe464f32 "Fix `using` followed by newline ignoring [no LineTerminator here] grammar restriction (#3869)": its changes miss the pull request's lines, which sit at 210 of its parent
  - 2026-05-18T05:05:08Z https://github.com/microsoft/typescript-go/commit/ce98adbc09fb3a08c360ade2452adaaa64473633 "Fix reparseTopLevelAwait diagnostic slicing bug (#3937)": its changes miss the pull request's lines, which sit at 210 of its parent
  - 2026-05-21T18:54:04Z https://github.com/microsoft/typescript-go/commit/d99f6b2a5ff82ab5ca80cb679d59600c90bc8f05 "fix(4016): skip unknown pragmas (#4020)": its changes miss the pull request's lines, which sit at 210 of its parent
  - 2026-06-03T19:29:30Z https://github.com/microsoft/typescript-go/commit/5ac05f485cbf1060effc0664b4de0f3386e8796b "Fix `.await` member access mis-parsed as top-level await in JS modules with JSDoc (#4169)": its changes miss the pull request's lines, which sit at 210 of its parent
  - 2026-06-09T22:11:26Z https://github.com/microsoft/typescript-go/commit/45ae27057224ba8bf421659eee56952a4ce219b2 "Fix top-level await reparsing with following `@typedef` (#4256)": its changes miss the pull request's lines, which sit at 212 of its parent
- Ruling: 

## 18. ESQL: DS: Add inference/RERANK tests

- Case: clean/elastic__elasticsearch-145229@619a409f
- Change: https://github.com/elastic/elasticsearch/pull/145229/files (69 changed lines in 15 files, Java)
- Commits: base ea3f1d17f94a532b1496000e2c573770803abfd4, head 89d0faf63cdeccaae56bfa778aad3369caba68e1; merged 2026-03-31T12:48:53Z as https://github.com/elastic/elasticsearch/commit/b1bfa5b9ae26d7bb11e48142a841d463421e8ff3
- Licence: NOASSERTION, LICENSE.txt (unverified: private runs only)
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-29T12:48:53Z (read 2026-10-12): 138 later commits on its files, 23 reading as a fix, revert or follow-up, none touching its lines
- Later commits on x-pack/plugin/esql-datasource-csv/qa/build.gradle: 9, 7 with no fix word (listed in suites/clean/candidates.json)
  - 2026-05-06T09:47:27Z https://github.com/elastic/elasticsearch/commit/8b43bf658035eb71761a7db8dea98d2341823543 "ESQL:DS: TSV: fix schema detection and extend testing (#148353)": its changes miss the pull request's lines, which sit at 36 of its parent
  - 2026-05-18T17:29:50Z https://github.com/elastic/elasticsearch/commit/85a9915260ef6433abf76e7e78026de3a34c1d07 "ESQL:DS: CSV: fix attributes' nullability (#149298)": its changes miss the pull request's lines, which sit at 36 of its parent
- Later commits on x-pack/plugin/esql-datasource-csv/qa/src/javaRestTest/java/org/elasticsearch/xpack/esql/qa/csv/Clusters.java: 4, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T09:46:20Z https://github.com/elastic/elasticsearch/commit/11abbf0331be43ce0884f7241c1e2a58f5e7bd0f "ESQL: DS: Fix datasource QA `path.repo` fallbacks (#145442)": its changes miss the pull request's lines, which sit at 31 of its parent
- Later commits on x-pack/plugin/esql-datasource-iceberg/qa/build.gradle: 5, 5 with no fix word (listed in suites/clean/candidates.json)
- Later commits on x-pack/plugin/esql-datasource-ndjson/qa/build.gradle: 6, 5 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-16T17:29:55Z https://github.com/elastic/elasticsearch/commit/550b347a8442c93bc6e6300dcf72e716f1058a21 "ESQL:DS: NDJSON plugin fixes (#146491)": its changes miss the pull request's lines, which sit at 36 of its parent
- Later commits on x-pack/plugin/esql-datasource-ndjson/qa/src/javaRestTest/java/org/elasticsearch/xpack/esql/qa/ndjson/Clusters.java: 3, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T09:46:20Z https://github.com/elastic/elasticsearch/commit/11abbf0331be43ce0884f7241c1e2a58f5e7bd0f "ESQL: DS: Fix datasource QA `path.repo` fallbacks (#145442)": its changes miss the pull request's lines, which sit at 31 of its parent
- Later commits on x-pack/plugin/esql-datasource-orc/qa/build.gradle: 7, 7 with no fix word (listed in suites/clean/candidates.json)
- Later commits on x-pack/plugin/esql-datasource-orc/qa/src/javaRestTest/java/org/elasticsearch/xpack/esql/qa/orc/Clusters.java: 1
  - 2026-04-02T09:46:20Z https://github.com/elastic/elasticsearch/commit/11abbf0331be43ce0884f7241c1e2a58f5e7bd0f "ESQL: DS: Fix datasource QA `path.repo` fallbacks (#145442)": its changes miss the pull request's lines, which sit at 32 of its parent
- Later commits on x-pack/plugin/esql-datasource-parquet/qa/build.gradle: 14, 13 with no fix word (listed in suites/clean/candidates.json)
  - 2026-05-13T11:58:38Z https://github.com/elastic/elasticsearch/commit/08b037144f1fca5a719aa9e6c055cbac41fd64ae "ESQL:DS: Parquet: fix bit allignment issue. Add IT (#148958)": its changes miss the pull request's lines, which sit at 42 to 43 of its parent
- Later commits on x-pack/plugin/esql-datasource-parquet/qa/src/javaRestTest/java/org/elasticsearch/xpack/esql/qa/parquet/Clusters.java: 5, 4 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T09:46:20Z https://github.com/elastic/elasticsearch/commit/11abbf0331be43ce0884f7241c1e2a58f5e7bd0f "ESQL: DS: Fix datasource QA `path.repo` fallbacks (#145442)": its changes miss the pull request's lines, which sit at 31 of its parent
- Later commits on x-pack/plugin/esql/qa/server/multi-node/src/javaRestTest/java/org/elasticsearch/xpack/esql/qa/multi_node/ExternalDistributedClusters.java: 3, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T09:46:20Z https://github.com/elastic/elasticsearch/commit/11abbf0331be43ce0884f7241c1e2a58f5e7bd0f "ESQL: DS: Fix datasource QA `path.repo` fallbacks (#145442)": its changes miss the pull request's lines, which sit at 31 of its parent
- Later commits on x-pack/plugin/esql/qa/server/src/main/java/org/elasticsearch/xpack/esql/qa/rest/AbstractExternalSourceSpecTestCase.java: 13, 8 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T09:46:20Z https://github.com/elastic/elasticsearch/commit/11abbf0331be43ce0884f7241c1e2a58f5e7bd0f "ESQL: DS: Fix datasource QA `path.repo` fallbacks (#145442)": its changes miss the pull request's lines, which sit at 13, 404 to 410 of its parent
  - 2026-05-04T15:11:54Z https://github.com/elastic/elasticsearch/commit/ab1fce783ea9d38d921e9246c298663673139f37 "ESQL: DS: Fix Azure URI handling (#148206)": its changes miss the pull request's lines, which sit at 13, 407 to 413 of its parent
  - 2026-05-06T09:47:27Z https://github.com/elastic/elasticsearch/commit/8b43bf658035eb71761a7db8dea98d2341823543 "ESQL:DS: TSV: fix schema detection and extend testing (#148353)": its changes miss the pull request's lines, which sit at 13, 421 to 427 of its parent
  - 2026-05-13T11:58:38Z https://github.com/elastic/elasticsearch/commit/08b037144f1fca5a719aa9e6c055cbac41fd64ae "ESQL:DS: Parquet: fix bit allignment issue. Add IT (#148958)": its changes miss the pull request's lines, which sit at 13, 494 to 500 of its parent
  - 2026-05-20T12:19:09Z https://github.com/elastic/elasticsearch/commit/875ec02515b73a551cb34872bf85c2adf8812d57 "[ESQL] Fix Windows glob path resolution in spec tests (#149469)": its changes miss the pull request's lines, which sit at 13, 521 to 527 of its parent
- Later commits on x-pack/plugin/esql/qa/server/src/main/java/org/elasticsearch/xpack/esql/qa/rest/EsqlSpecTestCase.java: 16, 15 with no fix word (listed in suites/clean/candidates.json)
  - 2026-06-25T18:52:19Z https://github.com/elastic/elasticsearch/commit/8ac231dbb552edc1c5b255eb51b4df9d26d6f6b5 "ESQL: Fix BWC tests against super old versions (#152197)": its changes miss the pull request's lines, which sit at 185, 336 to 345 of its parent
- Later commits on x-pack/plugin/esql/qa/testFixtures/src/main/java/org/elasticsearch/xpack/esql/CsvTestsDataLoader.java: 43, 37 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T11:09:45Z https://github.com/elastic/elasticsearch/commit/1684270707ce7e89d30b14b3122b78cf27ee699d "Fix deduplication of data with views (#145091)": its changes miss the pull request's lines, which sit at 46, 647 to 656 of its parent
  - 2026-05-23T03:56:28Z https://github.com/elastic/elasticsearch/commit/298ff430500ad1901c3da33ed827bae0cae4d467 "ESQL: Fix data type of partial folded CASE (#149752)": its changes miss the pull request's lines, which sit at 46, 690 to 699 of its parent
  - 2026-05-25T08:23:12Z https://github.com/elastic/elasticsearch/commit/c7d0e420c9712850375bf57ba9a5ae285ed57ff0 "Merge branch 'patch/serverless-fix'": its changes miss the pull request's lines, which sit at 46, 702 to 711 of its parent
  - 2026-06-03T01:59:10Z https://github.com/elastic/elasticsearch/commit/c26863d79e8ca8f8906f3262b0ddc7b062f3b348 "ESQL: fix unmapped_fields=load with LOOKUP JOIN (#148805)": its changes miss the pull request's lines, which sit at 46, 715 to 724 of its parent
  - 2026-06-19T15:03:44Z https://github.com/elastic/elasticsearch/commit/3e20f162994f3fd5af4f48f9e311cdbb126ef789 "[ES|QL] Fix union type class cast exception  (#151632)": its changes miss the pull request's lines, which sit at 46, 758 to 767 of its parent
  - 2026-06-22T18:30:39Z https://github.com/elastic/elasticsearch/commit/25b19d6a969c71b9527811d38ad8ac0a428cd4f5 "Bugfix: `TimeSeriesMetadataFieldBlockLoader` ignores passthrough fields (#151804)": its changes miss the pull request's lines, which sit at 46, 763 to 772 of its parent
- Later commits on x-pack/plugin/esql/qa/testFixtures/src/main/resources/external-basic.csv-spec: 9, 7 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-01T13:21:05Z https://github.com/elastic/elasticsearch/commit/12db0aa2fbd4191a1fe684c4008644a812f17c7c "[ESQL] Fix release tests (#145391)": its changes miss the pull request's lines, which sit at 779 to 790, 792 to 797 of its parent
  - 2026-06-26T13:53:45Z https://github.com/elastic/elasticsearch/commit/6912a3d3ce622bec7750facb9303ad26d55ce35e "ES|QL|DS Fix missing references error in planning (#152029)": its changes miss the pull request's lines, which sit at 689 of its parent
- Ruling: 

## 19. [frontport] Add WASM bytecode size panels to Execution dashboard (#5765)

- Case: clean/linera-io__linera-protocol-5856@427b9982
- Change: https://github.com/linera-io/linera-protocol/pull/5856/files (332 changed lines in 1 file, Rust)
- Commits: base 8ff219c913a555fae091f4d417a68f9db4a59b63, head 5985f5004cb181a50eda52977a54e143968db1ea; merged 2026-03-30T18:59:26Z as https://github.com/linera-io/linera-protocol/commit/47202ebba5a53349bd21634f9bd7a777e5366f71
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T18:59:26Z (read 2026-10-12): 6 later commits on its files, 3 reading as a fix, revert or follow-up, none touching its lines
- Later commits on kubernetes/linera-validator/grafana-dashboards/linera/execution.json: 6, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-06T15:28:22Z https://github.com/linera-io/linera-protocol/commit/4a196a2836b7a4631a8f8e5a35df87712c109671 "Fix unit label on State Hash Computation Latency dashboard panel (#5923)": its changes miss the pull request's lines, which sit at 6064 to 6395 of its parent
  - 2026-04-08T12:17:02Z https://github.com/linera-io/linera-protocol/commit/d20332a8fda4450c422c2bbbf341f46d7ac163fa "Fix dashboard restart annotations to detect actual pod restarts (#5941)": its changes miss the pull request's lines, which sit at 6064 to 6395 of its parent
  - 2026-05-15T13:42:51Z https://github.com/linera-io/linera-protocol/commit/914211863a9d1775e1ecbf9c4b1b9e7da57f6f84 "dashboard: sync bundled JSONs — multi-select validator var + Loki perf fixes (#6310)": its changes miss the pull request's lines, which sit at 6064 to 6395 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/linera-io/linera-protocol/pull/5889 "[frontport] Circuit breaker for validator notification streams (#5717)"
- Ruling: 

## 20. Fix editor not updating titlebar with new difficulty name after rename

- Case: clean/ppy__osu-36908@97de402f
- Change: https://github.com/ppy/osu/pull/36908/files (16 changed lines in 1 file, C#)
- Commits: base 321e6989061246275f30ef80030fe560109291fd, head ec66e93d5f7336fdb2aa5e5e9a5eeb2003136042; merged 2026-03-10T08:57:26Z as https://github.com/ppy/osu/commit/9105fc15b244a0c3a4d59241d7529de7562500cb
- Licence: MIT, LICENCE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-08T08:57:26Z (read 2026-10-12): 6 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on osu.Game/Screens/Edit/Editor.cs: 6, 5 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-23T08:26:34Z https://github.com/ppy/osu/commit/95648a3d27a0c9c4e544c445f9baba4a8c5b8948 "Fix editor background taking too long to load with certain storyboards (#37038)": its changes miss the pull request's lines, which sit at 191 to 193, 195 to 196, 198, 606 to 608 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/LumpBloom7/hishigata/pull/317 "Bump ppy.osu.Game from 2026.303.0 to 2026.315.0"; https://github.com/Rudicito/gitaroo/pull/77 "Bump ppy.osu.Game from 2026.119.0 to 2026.315.0"; https://github.com/goodtrailer/soyokaze/pull/250 "Bump ppy.osu.Game from 2026.102.0 to 2026.315.0"; https://github.com/LumpBloom7/sentakki/pull/823 "Bump ppy.osu.Game from 2026.303.0 to 2026.315.0"; https://github.com/Beamographic/rush/pull/428 "Bump ppy.osu.Game from 2026.303.0 to 2026.315.0"; https://github.com/GooGuTeam/osu-performance-server/pull/33 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/581 "Bump ppy.osu.Game from 2026.303.0 to 2026.317.0"; https://github.com/GooGuTeam/custom-rulesets/pull/32 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/hishigata/pull/318 "Bump ppy.osu.Game from 2026.303.0 to 2026.317.0"; https://github.com/Rudicito/gitaroo/pull/78 "Bump ppy.osu.Game from 2026.119.0 to 2026.317.0"; https://github.com/goodtrailer/soyokaze/pull/251 "Bump ppy.osu.Game from 2026.102.0 to 2026.317.0"; https://github.com/LumpBloom7/sentakki/pull/825 "Bump NUnit and ppy.osu.Game"; https://github.com/GooGuTeam/osu-performance-server/pull/34 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/sentakki/pull/835 "Bump NUnit and ppy.osu.Game"; https://github.com/GooGuTeam/osu-performance-server/pull/35 "Bump the osu-game group with 5 updates"; https://github.com/GooGuTeam/custom-rulesets/pull/33 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/hishigata/pull/320 "Bump ppy.osu.Game from 2026.303.0 to 2026.406.0"; https://github.com/Rudicito/gitaroo/pull/80 "Bump ppy.osu.Game from 2026.303.0 to 2026.406.0"; https://github.com/goodtrailer/soyokaze/pull/252 "Bump ppy.osu.Game from 2026.317.0 to 2026.406.0"; https://github.com/taulazer/tau/pull/584 "Bump ppy.osu.Game from 2026.303.0 to 2026.406.0"; https://github.com/goodtrailer/soyokaze/pull/253 "Bump ppy.osu.Game from 2026.317.0 to 2026.408.0"; https://github.com/LumpBloom7/sentakki/pull/837 "Bump NUnit and ppy.osu.Game"; https://github.com/GooGuTeam/osu-performance-server/pull/36 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/585 "Bump ppy.osu.Game from 2026.303.0 to 2026.408.0"; https://github.com/GooGuTeam/custom-rulesets/pull/34 "Bump the osu-game group with 5 updates"; https://github.com/LumpBloom7/hishigata/pull/322 "Bump ppy.osu.Game from 2026.303.0 to 2026.408.0"; https://github.com/Game4all/gamebosu/pull/287 "Bump ppy.osu.Game from 2025.816.0 to 2026.408.0"; https://github.com/goodtrailer/soyokaze/pull/254 "Bump ppy.osu.Game from 2026.317.0 to 2026.429.0"; https://github.com/GooGuTeam/osu-performance-server/pull/38 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/587 "Bump ppy.osu.Game from 2026.303.0 to 2026.429.0"; https://github.com/GooGuTeam/custom-rulesets/pull/39 "Bump the osu-game group with 5 updates"; https://github.com/Game4all/gamebosu/pull/289 "Bump ppy.osu.Game from 2025.816.0 to 2026.429.0"; https://github.com/goodtrailer/soyokaze/pull/255 "Bump ppy.osu.Game from 2026.317.0 to 2026.505.0"; https://github.com/GooGuTeam/osu-performance-server/pull/39 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/589 "Bump ppy.osu.Game from 2026.303.0 to 2026.505.0"; https://github.com/GooGuTeam/custom-rulesets/pull/40 "Bump the osu-game group with 5 updates"; https://github.com/Game4all/gamebosu/pull/291 "Bump ppy.osu.Game from 2025.816.0 to 2026.505.0"; https://github.com/goodtrailer/soyokaze/pull/256 "Bump ppy.osu.Game from 2026.317.0 to 2026.518.0"; https://github.com/GooGuTeam/osu-performance-server/pull/41 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/590 "Bump ppy.osu.Game from 2026.303.0 to 2026.518.0"; https://github.com/GooGuTeam/custom-rulesets/pull/41 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/592 "Bump ppy.osu.Game from 2026.303.0 to 2026.522.0"; https://github.com/GooGuTeam/custom-rulesets/pull/42 "Bump the osu-game group with 5 updates"; https://github.com/goodtrailer/soyokaze/pull/257 "Bump ppy.osu.Game from 2026.317.0 to 2026.522.0"; https://github.com/GooGuTeam/osu-performance-server/pull/42 "Bump the osu-game group with 5 updates"; https://github.com/GooGuTeam/osu-performance-server/pull/43 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/594 "Bump ppy.osu.Game from 2026.303.0 to 2026.527.0"; https://github.com/GooGuTeam/custom-rulesets/pull/43 "Bump the osu-game group with 5 updates"; https://github.com/goodtrailer/soyokaze/pull/258 "Bump ppy.osu.Game from 2026.317.0 to 2026.527.0"; https://github.com/goodtrailer/soyokaze/pull/259 "Bump ppy.osu.Game from 2026.317.0 to 2026.601.0"; https://github.com/taulazer/tau/pull/595 "Bump ppy.osu.Game from 2026.303.0 to 2026.601.0"; https://github.com/GooGuTeam/custom-rulesets/pull/44 "Bump the osu-game group with 5 updates"; https://github.com/goodtrailer/soyokaze/pull/260 "Bump ppy.osu.Game from 2026.317.0 to 2026.605.0"; https://github.com/taulazer/tau/pull/596 "Bump ppy.osu.Game from 2026.303.0 to 2026.605.0"; https://github.com/GooGuTeam/custom-rulesets/pull/45 "Bump ppy.osu.Game and 4 others"
- Ruling: 

## 21. fix(graph): class bug in serialization

- Case: clean/alibaba__spring-ai-alibaba-3969@38476032
- Change: https://github.com/alibaba/spring-ai-alibaba/pull/3969/files (736 changed lines in 6 files, Java)
- Commits: base 7a73cb0d437d44b363767eb3a0b5ea8adbfe1ae3, head 643de4ca4ea1eb7fffd700b5a003449ba6876af7; merged 2026-01-08T03:19:15Z as https://github.com/alibaba/spring-ai-alibaba/commit/4186368f3dfdf058f1142f377732c40ad2d41eec
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-04-08T03:19:15Z (read 2026-10-12): 1 later commit on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on spring-ai-alibaba-graph-core/src/main/java/com/alibaba/cloud/ai/graph/serializer/plain_text/jackson/JacksonDeserializer.java: 1
  - 2026-01-22T09:08:19Z https://github.com/alibaba/spring-ai-alibaba/commit/13b1e22d18a7c16ffbe31e34cd9b7a49750b6000 "fix(graph): java.lang Serialization failed (#4111)": its changes miss the pull request's lines, which sit at 100 to 104, 322 to 326, 471 to 475 of its parent
- Ruling: 

## 22. perf(server): optimize people page query

- Case: clean/immich-app__immich-27346@3fd9fbbd
- Change: https://github.com/immich-app/immich/pull/27346/files (4 changed lines in 2 files, TypeScript)
- Commits: base eb20b715e4bb6c6668890f3b79fff6f541987d93, head 7434d1c2cdf77a77c213d497abdd2ee3323ed591; merged 2026-03-28T21:33:05Z as https://github.com/immich-app/immich/commit/b09ebb11e9cf49eb236f5fdabfe897302cf39c31
- Licence: AGPL-3.0, LICENSE
- Reviews by others: 4 (approved 2, commented 2); none requested changes
- Checked up to 2026-06-26T21:33:05Z (read 2026-10-12): 9 later commits on its files, 6 reading as a fix, revert or follow-up, none touching its lines
- Later commits on server/src/queries/person.repository.sql: 4, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-01T12:19:38Z https://github.com/immich-app/immich/commit/c29493e3a0bd0a629648fe6cd7c72887d264b931 "fix: withFilePath select edited or unedited file (#27328)": its changes miss the pull request's lines, which sit at 230 to 231, 236 of its parent
  - 2026-04-01T13:31:54Z https://github.com/immich-app/immich/commit/d1e2e8ab4e9b01951ecc38c664a392cb0d51a7b5 "fix(server): use substring matching for person name search (#26903)": its changes miss the pull request's lines, which sit at 230 to 231, 236 of its parent
  - 2026-04-09T00:56:07Z https://github.com/immich-app/immich/commit/8d67c1f820aaec8d52ce8c1eb04a15ff0c4d81d9 "fix(server): people search not showing for 3 or less characters (#27629)": its changes miss the pull request's lines, which sit at 227 to 228, 233 of its parent
- Later commits on server/src/repositories/person.repository.ts: 5, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-01T12:19:38Z https://github.com/immich-app/immich/commit/c29493e3a0bd0a629648fe6cd7c72887d264b931 "fix: withFilePath select edited or unedited file (#27328)": its changes miss the pull request's lines, which sit at 354 to 355, 361 of its parent
  - 2026-04-01T13:31:54Z https://github.com/immich-app/immich/commit/d1e2e8ab4e9b01951ecc38c664a392cb0d51a7b5 "fix(server): use substring matching for person name search (#26903)": its changes miss the pull request's lines, which sit at 346 to 347, 353 of its parent
  - 2026-04-09T00:56:07Z https://github.com/immich-app/immich/commit/8d67c1f820aaec8d52ce8c1eb04a15ff0c4d81d9 "fix(server): people search not showing for 3 or less characters (#27629)": its changes miss the pull request's lines, which sit at 340 to 341, 347 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/claytono/infra/pull/2048 "Update immich monorepo to v2.7.5"
- Ruling: 

## 23. Add missing Slovak chart filter action translations

- Case: clean/filamentphp__filament-19318@d64ad624
- Change: https://github.com/filamentphp/filament/pull/19318/files (16 changed lines in 1 file, PHP)
- Commits: base be9a8da37577cf2d73fe19a3ef93caaea0478099, head ebf7b147a4c538ef414f87a89dcd85c30aa65ff5; merged 2026-02-23T08:24:19Z as https://github.com/filamentphp/filament/commit/ada995d009434685500d674d24e0abb5680d4780
- Licence: MIT, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-24T08:24:19Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

## 24. Fix crash on invalid `format_regexp` in `Regexp` format

- Case: clean/ClickHouse__ClickHouse-101074@efd27989
- Change: https://github.com/ClickHouse/ClickHouse/pull/101074/files (9 changed lines in 3 files, C++)
- Commits: base cef81be62ebc151aed7b98e9e11059ca2250518c, head 90f373b0f63e9274a8a003c4a8ed783d0b780cc5; merged 2026-03-29T19:24:00Z as https://github.com/ClickHouse/ClickHouse/commit/c037aa07f83814496fbfc5ad61d14b265fdfe9d6
- Licence: Apache-2.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-27T19:24:00Z (read 2026-10-12): 2 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/Processors/Formats/Impl/RegexpRowInputFormat.cpp: 2, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-29T23:20:54Z https://github.com/ClickHouse/ClickHouse/commit/371e0b496d41773dfa7d268ebb4bed47f1c48664 "Merge remote-tracking branch 'origin/master' into fix-compiler-warnings": a merge into another branch: its first parent does not hold the pull request
- Ruling: 

## 25. Create LTS pkg and non-LTS pkg for macOS for LTS releases

- Case: clean/PowerShell__PowerShell-27039@d7b9ca6b
- Change: https://github.com/PowerShell/PowerShell/pull/27039/files (13 changed lines in 1 file, C#)
- Commits: base 1f8bbe1e5332bb8fe1b39c81c366ddadbf9dd1a2, head b0f291545353eaa900dcd37c887758762dda3596; merged 2026-03-16T19:40:27Z as https://github.com/PowerShell/PowerShell/commit/8c9c9e11872c8d98c2e7d7a1ed991fc7e1d07354
- Licence: MIT, LICENSE.txt
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-14T19:40:27Z (read 2026-10-12): 3 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on .pipelines/templates/mac-package-build.yml: 3, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-05-05T19:47:42Z https://github.com/PowerShell/PowerShell/commit/3d13188032c3784ecbf7a9cb6111aefe6bf7ba61 "Fix executable permissions for pwsh and createdump": its changes miss the pull request's lines, which sit at 113 to 116, 135, 142 to 147 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/PowerShell/PowerShell/pull/27040 "[release/v7.6] Create LTS pkg and non-LTS pkg for macOS for LTS releases"; https://github.com/PowerShell/PowerShell/pull/27162 "[release/v7.5.6] Create LTS pkg and non-LTS pkg for macOS for LTS releases"
- Ruling: 

## 26. [DevTools] Ignore new production renderers if we already use "worse" versions of React on a page

- Case: clean/react__react-35994@4c43106e
- Change: https://github.com/react/react/pull/35994/files (104 changed lines in 6 files, JavaScript)
- Commits: base 014138df87869b174956f90a33fd6cf66e160114, head 209a41cdcffefcc3364f606e645dd9c0a756acf1; merged 2026-03-11T09:26:36Z as https://github.com/react/react/commit/7b5b561bd2dda205ed8f397864379003b707d4ae
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-09T09:26:36Z (read 2026-10-12): 2 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on packages/react-devtools-shared/src/hook.js: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/vercel/next.js/pull/91272 "Upgrade React from `46103596-20260305` to `5e9eedb5-20260312`"
- Ruling: 

## 27. validation: refactor: remove ConnectTrace

- Case: clean/bitcoin__bitcoin-34708@892f8aab
- Change: https://github.com/bitcoin/bitcoin/pull/34708/files (66 changed lines in 2 files, C++)
- Commits: base 083242aac81d02b6547ca37e0b4e6f37e0e89d87, head 2f8f2e900118c98699db91075bd1b72e6460c6b1; merged 2026-03-12T10:09:05Z as https://github.com/bitcoin/bitcoin/commit/ab642773757cb9035d348f41fcd13103f5a4734f
- Licence: MIT, COPYING
- Reviews by others: 10 (approved 1, commented 9); none requested changes
- Checked up to 2026-06-10T10:09:05Z (read 2026-10-12): 34 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/validation.cpp: 30, 29 with no fix word (listed in suites/clean/candidates.json)
  - 2026-05-26T11:36:57Z https://github.com/bitcoin/bitcoin/commit/ac9424fdc6339abb72e5f9db5a46f84703802429 "Merge bitcoin/bitcoin#35145: validation: fix misleading VerifyDB summary log": its changes miss the pull request's lines, which sit at 2992 to 2995, 3001, 3007, 3104, 3352, 3360 of its parent
- Later commits on src/validation.h: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 28. [13.x] Update brick/math constraint and rounding mode constant

- Case: clean/laravel__framework-59107@ed99ecdd
- Change: https://github.com/laravel/framework/pull/59107/files (8 changed lines in 4 files, PHP)
- Commits: base 297c6bb97df31df21b241d284c2360095176aa05, head 7a97bd823db0ca88cd2c3c69e7420c5452f2cbbf; merged 2026-03-05T19:21:41Z as https://github.com/laravel/framework/commit/63c8c8f377b502cb50ffaffc841aaba3e811c45e
- Licence: MIT, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-03T19:21:41Z (read 2026-10-12): 26 later commits on its files, 5 reading as a fix, revert or follow-up, none touching its lines
- Later commits on composer.json: 14, 12 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-10T20:04:12Z https://github.com/laravel/framework/commit/6b0638a6c0e3e1ce5d6b0150c27797da46e393ba "fix conflicts": its changes miss the pull request's lines, which sit at 30 of its parent
  - 2026-03-17T13:09:53Z https://github.com/laravel/framework/commit/89338e9ecc379a879001b38a649185db6eb5283c "Fix failing phpstan (#59245)": every line of the pull request in the file was already rewritten before this commit
- Later commits on src/Illuminate/Database/Eloquent/Concerns/HasAttributes.php: 5, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-27T17:21:20Z https://github.com/laravel/framework/commit/45b8782cd563b8bbaa22ad3ab332d7ec52d9381b "[13.x] Fix trait initializer collision with Attribute parsing (#59404)": its changes miss the pull request's lines, which sit at 1541 of its parent
  - 2026-04-01T15:19:04Z https://github.com/laravel/framework/commit/8843a5e3f931e005e7f3c9046bc83f6e664c53f5 "fix: allow returning Stringable objects in casts()-method (#59479)": its changes miss the pull request's lines, which sit at 1539 of its parent
  - 2026-05-14T17:30:07Z https://github.com/laravel/framework/commit/1906399903ddeb68b0cd6381f3050fc2e170c578 "Fix typo in mergeAttributeFromCachedCasts() PHPDoc comment (#60112)": its changes miss the pull request's lines, which sit at 1539 of its parent
- Later commits on src/Illuminate/Database/composer.json: 5, 5 with no fix word (listed in suites/clean/candidates.json)
- Later commits on src/Illuminate/Validation/composer.json: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 29. fix: use matrix.target instead of matrix.os for actions/cache build action

- Case: clean/openai__codex-15933@93787e80
- Change: https://github.com/openai/codex/pull/15933/files (6 changed lines in 1 file, Rust)
- Commits: base 81fa04783a551d7e2fc5cfdfc91921aaec3e64bb, head eb3dbd0a5f123e13c02184b4c1fbabb0ae8ba585; merged 2026-03-27T01:32:14Z as https://github.com/openai/codex/commit/d838c23867f6fe2e3e43a0c82d25c17cb3730b1d
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-25T01:32:14Z (read 2026-10-12): 40 later commits on its files, 6 reading as a fix, revert or follow-up, none touching its lines
- Later commits on .github/workflows/bazel.yml: 40, 34 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-14T01:45:41Z https://github.com/openai/codex/commit/d9a385ac8c2ff91b3180cddd3c973095eafb2d88 "fix: pin inputs (#17471)": its changes miss the pull request's lines, which sit at 71, 73, 231 of its parent
  - 2026-04-15T21:43:30Z https://github.com/openai/codex/commit/17d94bd1e32f8f75676a0927ca297031f4b7d7ae "[docs] Revert extra changes from PR 17848 (#18003)": its changes miss the pull request's lines, which sit at 120, 279 of its parent
  - 2026-04-25T17:03:01Z https://github.com/openai/codex/commit/88f300d74d93bfee6750100ee5d3056672cad3ad "fix: increase Bazel timeout to 45 minutes (#19578)": every line of the pull request in the file was already rewritten before this commit
  - 2026-04-25T23:34:06Z https://github.com/openai/codex/commit/9881dc7306dbfe22b34157e6e47de2b1ae45d527 "fix: restore 30-minute timeout for Bazel builds (#19609)": every line of the pull request in the file was already rewritten before this commit
  - 2026-06-02T18:06:01Z https://github.com/openai/codex/commit/9e3d5f29e2b6e2bcad3b0384e35e1faaa13e8272 "[codex] Revert shared BuildBuddy Bazel wrapper (#25909)": every line of the pull request in the file was already rewritten before this commit
  - 2026-06-02T23:22:32Z https://github.com/openai/codex/commit/6471f8b31aba50c87d5616cc0a203160a80b5322 "[codex] Fix Windows BuildBuddy Bazel wrapper execution (#25915)": every line of the pull request in the file was already rewritten before this commit
- Ruling: 

## 30. chore(deps): consolidate dependabot updates 2026-03-24

- Case: clean/gofr-dev__gofr-3206@ad4db8a3
- Change: https://github.com/gofr-dev/gofr/pull/3206/files (468 changed lines in 17 files, Go)
- Commits: base 841f3820eb1b8d63af5430285124d7dc86024c91, head f0b80c55a726c3b84253845e8101264006a220e9; merged 2026-03-24T06:08:07Z as https://github.com/gofr-dev/gofr/commit/ccfd5c7710cd0a696f1827923dc2e81d918bf425
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-22T06:08:07Z (read 2026-10-12): 128 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on go.mod: 12, 12 with no fix word (listed in suites/clean/candidates.json)
- Later commits on go.sum: 11, 11 with no fix word (listed in suites/clean/candidates.json)
- Later commits on go.work.sum: 8, 8 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/couchbase/go.mod: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/couchbase/go.sum: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/file/gcs/go.mod: 11, 11 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/file/gcs/go.sum: 10, 10 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/file/s3/go.mod: 11, 11 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/file/s3/go.sum: 10, 10 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/influxdb/go.mod: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/influxdb/go.sum: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/kv-store/dynamodb/go.mod: 8, 8 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/kv-store/dynamodb/go.sum: 7, 7 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/pubsub/sqs/go.mod: 11, 11 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/pubsub/sqs/go.sum: 10, 10 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/surrealdb/go.mod: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on pkg/gofr/datasource/surrealdb/go.sum: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 31. test: add missing unit tests for HTTP request (HostName, PathParam, body, Bind)

- Case: clean/gofr-dev__gofr-3221@2fce3575
- Change: https://github.com/gofr-dev/gofr/pull/3221/files (84 changed lines in 1 file, Go)
- Commits: base 20a401d52df6f90647ac309c06b53d2bb29ea977, head fc6859edf13ba9907a8ede02409caca815302aa7; merged 2026-03-30T18:31:41Z as https://github.com/gofr-dev/gofr/commit/8ec5abf83bedd3b650422c008282aa9f41ec52a7
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T18:31:41Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

## 32. chore: Collect telemetry on state update message sizes

- Case: clean/cline__cline-9626@7b80e48f
- Change: https://github.com/cline/cline/pull/9626/files (91 changed lines in 3 files, TypeScript)
- Commits: base fd8cecddd51653a906708c3a7694fb9f7b7c098f, head a1978498c1c0dbbb8cddc7690d1ef5978863c912; merged 2026-03-03T05:53:30Z as https://github.com/cline/cline/commit/fb04a9bd1532e3a8edfa7a2b5434fef365589f44
- Licence: Apache-2.0, LICENSE
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-01T05:53:30Z (read 2026-10-12): 15 later commits on its files, 3 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/core/controller/state/subscribeToState.ts: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on src/services/telemetry/TelemetryService.ts: 10, 8 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-09T22:55:23Z https://github.com/cline/cline/commit/ffa4785f431893afcf7f8b51c2e9ac5fe009409a "fix(telemetry): restore cache token and cost metrics in captureTokenUsage (#9741)": its changes miss the pull request's lines, which sit at 179 to 181, 2306 to 2334 of its parent
  - 2026-04-30T16:41:52Z https://github.com/cline/cline/commit/beb3ad78dc5c638eaae8be54d0502cdc812633b8 "Revert "Remove foreground terminal from Cline VSCode extension (#10196)" (#10477)": its changes miss the pull request's lines, which sit at 192 to 194, 2355 to 2383 of its parent
- Later commits on src/services/telemetry/__tests__/TelemetryService.metrics.test.ts: 4, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-09T22:55:23Z https://github.com/cline/cline/commit/ffa4785f431893afcf7f8b51c2e9ac5fe009409a "fix(telemetry): restore cache token and cost metrics in captureTokenUsage (#9741)": its changes miss the pull request's lines, which sit at 238 to 276 of its parent
- Ruling: 

## 33. [DevTools] Don't capture durations for disconnected subtrees when profiling

- Case: clean/react__react-35718@52edac83
- Change: https://github.com/react/react/pull/35718/files (79 changed lines in 2 files, JavaScript)
- Commits: base 65db1000b944c8a07b5947c06b38eb8364dce4f2, head a1c0c6d100a02840f7e78a60f0803849fa236631; merged 2026-02-09T22:18:17Z as https://github.com/react/react/commit/c6bb26bf833c5d91760daf28fa2750b81067ac30
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-10T22:18:17Z (read 2026-10-12): 10 later commits on its files, 2 reading as a fix, revert or follow-up, none touching its lines
- Later commits on packages/react-devtools-shared/src/__tests__/profilingCommitTreeBuilder-test.js: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on packages/react-devtools-shared/src/backend/fiber/renderer.js: 9, 7 with no fix word (listed in suites/clean/candidates.json)
  - 2026-02-10T12:09:23Z https://github.com/react/react/commit/f23aa1d9f5034e7cfbd3e6015ce102bb72a005a0 "[DevTools] Fix memory leak when unmounting hoistables (#35741)": its changes miss the pull request's lines, which sit at 5584 to 5589 of its parent
  - 2026-03-10T17:05:48Z https://github.com/react/react/commit/014138df87869b174956f90a33fd6cf66e160114 "[DevTools] Fix a crash when rendering a new class Component when simulating errored state (#35985)": its changes miss the pull request's lines, which sit at 5267 to 5272 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/vercel/next.js/pull/89923 "Upgrade React from `272441a9-20260209` to `6066c782-20260212`"
- Ruling: 

## 34. quic: remove CryptoKey support from session keys option

- Case: clean/nodejs__node-62335@24bde697
- Change: https://github.com/nodejs/node/pull/62335/files (20 changed lines in 3 files, JavaScript)
- Commits: base 56aba88702b3a7da4a44688664ff22d8afebb267, head e4d41d4c923f0933bcd07ba750ba26de5dd9ccca; merged 2026-03-28T09:00:58Z as https://github.com/nodejs/node/commit/cf2b05cab867568f344ed58829f656162685454c
- Licence: NOASSERTION, LICENSE (unverified: private runs only)
- Reviews by others: 3 (approved 3); none requested changes
- Checked up to 2026-06-26T09:00:58Z (read 2026-10-12): 65 later commits on its files, 4 reading as a fix, revert or follow-up, none touching its lines
- Later commits on doc/api/quic.md: 33, 31 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-31T12:34:32Z https://github.com/nodejs/node/commit/60f19bc0894eb20f9e525c27b561ef322039382a "doc: fix 'transfered' typo in quic.md": its changes miss the pull request's lines, which sit at 1200 to 1203, 1206 of its parent
  - 2026-05-05T16:14:46Z https://github.com/nodejs/node/commit/a641226c9187c9748a3100d18c3a511462dfafae "doc: fix lint-md": its changes miss the pull request's lines, which sit at 1251, 1256 to 1257, 1260 of its parent
- Later commits on lib/internal/quic/quic.js: 26, 24 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-31T16:19:44Z https://github.com/nodejs/node/commit/57186e58277b7b0235d5e439356c3e2ab811d3e0 "quic: fix a handful of bugs and missing functionality": its changes miss the pull request's lines, which sit at 100 to 101, 144 to 145, 187 to 188, 260, 2170 to 2172 of its parent
  - 2026-05-15T13:39:30Z https://github.com/nodejs/node/commit/e9c49ea46f5303c9f3f0860286f08a25caa54851 "quic: fixup quic stream variable chunk len": its changes miss the pull request's lines, which sit at 148 to 149, 206, 276 to 277 of its parent
- Later commits on lib/internal/quic/symbols.js: 6, 6 with no fix word (listed in suites/clean/candidates.json)
- Later commits naming it (quoting its title, or with no fix word): https://github.com/nodejs/node/commit/510ec81fbe6423ddcc0171b61b7786b239e03f00 "quic: remove CryptoKey support from session keys option"; https://github.com/nodejs/node/commit/aa26015b8be9e79b1c0135a8d636a430d5838968 "quic: remove CryptoKey support from session keys option"; https://github.com/nodejs/node/commit/6fb5c6ac627f5fdb5a491ef25147e80ade8ee926 "quic: remove CryptoKey support from session keys option"; https://github.com/nodejs/node/commit/4272a97d4c578f95143eb11d8cf43f6daa0e39b8 "quic: remove CryptoKey support from session keys option"; https://github.com/nodejs/node/commit/9d3087c6041ebf38e7f96d1fc5b71d915c50f1db "quic: remove CryptoKey support from session keys option"; https://github.com/nodejs/node/commit/962fc2d0a710ef19143d20479646fb54ad2ecd72 "quic: remove CryptoKey support from session keys option"; https://github.com/nodejs/node/commit/4c206ecb31f232535edd591a90fdf301191ad523 "quic: remove CryptoKey support from session keys option"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/nodejs/node/pull/62522 "2026-04-01, Version 25.9.0 (Current)"; https://github.com/nodejs/node/pull/62681 "2026-04-15, Version 24.15.0 'Krypton' (LTS)"
- Ruling: 

## 35. Add Claude PR review capability

- Case: clean/timescale__timescaledb-9408@58b20f80
- Change: https://github.com/timescale/timescaledb/pull/9408/files (41 changed lines in 1 file, C)
- Commits: base a30f9b4dbdc44e78ede28004b8650ade947d53b5, head 7fa3155b9b5c89db81f811982b8c09bad1d2454a; merged 2026-03-17T13:55:50Z as https://github.com/timescale/timescaledb/commit/e027c16a2bd8a050642d4ac22fc7ca9c9fcf9378
- Licence: NOASSERTION, LICENSE (unverified: private runs only)
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-06-15T13:55:50Z (read 2026-10-12): 12 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on .github/workflows/claude-code-review.yaml: 12, 12 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 36. feat(a2a): support multi-agent registration in single application

- Case: clean/alibaba__spring-ai-alibaba-4419@f0686e50
- Change: https://github.com/alibaba/spring-ai-alibaba/pull/4419/files (885 changed lines in 14 files, Java)
- Commits: base f62f943c6c579b7c38ab088ffada54ec4dab72de, head ad86b2f69b5d0644ee7990647fb03e149275ca73; merged 2026-03-14T09:02:30Z as https://github.com/alibaba/spring-ai-alibaba/commit/99c8d3fcc1270f5d44104659d03d149af8eb8bbb
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-12T09:02:30Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

## 37. Add comprehensive array and dictionary tests for ConvertTo-Json

- Case: clean/PowerShell__PowerShell-26742@70c743b8
- Change: https://github.com/PowerShell/PowerShell/pull/26742/files (457 changed lines in 1 file, C#)
- Commits: base dd4f2fecfaf2e9dc1fbb8831fa47c8b0907c03a3, head 1ce7708b455b4a1b67fb914f5ddd29b5e61f0365; merged 2026-02-06T17:41:03Z as https://github.com/PowerShell/PowerShell/commit/438254412760ff24cdfebeed09bfeb3a24882866
- Licence: MIT, LICENSE.txt
- Reviews by others: 5 (approved 2, commented 3); none requested changes
- Checked up to 2026-05-07T17:41:03Z (read 2026-10-12): 3 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on test/powershell/Modules/Microsoft.PowerShell.Utility/ConvertTo-Json.Tests.ps1: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 38. Fix segfault in Vectorized Aggregation

- Case: clean/timescale__timescaledb-9426@e64b5725
- Change: https://github.com/timescale/timescaledb/pull/9426/files (146 changed lines in 6 files, C)
- Commits: base bed7bdd81b0ec32ff1d4bedcf87e08b9ce70b8a1, head b81b29c1eef1e5427f13ad6a10d8e72da37b01f9; merged 2026-03-23T19:27:10Z as https://github.com/timescale/timescaledb/commit/baeb5eaaeead6a1ee2584f16f65a954709763d0c
- Licence: NOASSERTION, LICENSE (unverified: private runs only)
- Reviews by others: 4 (approved 3, commented 1); none requested changes
- Checked up to 2026-06-21T19:27:10Z (read 2026-10-12): 9 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on tsl/src/nodes/vector_agg/plan.c: 4, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-06-01T13:24:03Z https://github.com/timescale/timescaledb/commit/217fe4c1599a31dbaa3c81edd42ea317733e4458 "Fix wrong grouping in VectorAgg and ColumnarIndexScan": its changes miss the pull request's lines, which sit at 15, 692 to 708, 710, 712 to 728, 735, 782 of its parent
- Later commits on tsl/test/expected/vector_agg_planning-15.out: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later commits on tsl/test/expected/vector_agg_planning-16.out: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on tsl/test/expected/vector_agg_planning-17.out: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on tsl/test/expected/vector_agg_planning-18.out: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/timescale/timescaledb/pull/9429 "Backport to 2.26.x: #9426: Fix segfault in Vectorized Aggregation"
- Ruling: 

## 39. Update milestones for May

- Case: clean/dotnet__aspnetcore-65976@4ffef909
- Change: https://github.com/dotnet/aspnetcore/pull/65976/files (6 changed lines in 1 file, C#)
- Commits: base 53559ddd9f193ffe004f27ec6ccc1c88a8529033, head 453faa3a667f8d3fd560abbfa68b92d9cfb5e848; merged 2026-03-25T16:42:14Z as https://github.com/dotnet/aspnetcore/commit/9d746bd1fa42178150bf480cf7c86a7e6e0c5ea2
- Licence: MIT, LICENSE.txt
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-23T16:42:14Z (read 2026-10-12): 11 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on .github/policies/resourceManagement.yml: 11, 11 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/dotnet/dotnet/pull/5713 "[main] Source code updates from dotnet/aspnetcore"; https://github.com/dotnet/aspnetcore/pull/66432 "Update resourceManagement for 10.0.8 milestone"
- Ruling: 

## 40. fix tunnel process kill and daemon spawn on windows

- Case: clean/browser-use__browser-use-4530@8e204eb1
- Change: https://github.com/browser-use/browser-use/pull/4530/files (58 changed lines in 1 file, Python)
- Commits: base 86d33635c592e5dea6f8513e76cf932d4e4120fb, head 4950c3baa1638acc7efccadda1ea87eec77eb338; merged 2026-03-25T23:34:17Z as https://github.com/browser-use/browser-use/commit/6ce58afbc3f10d2184c34c2fc221f06592b46136
- Licence: MIT, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-23T23:34:17Z (read 2026-10-12): 1 later commit on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on browser_use/skill_cli/tunnel.py: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 41. ci: fix windows cgo compiler error

- Case: clean/ollama__ollama-15046@e8fa2087
- Change: https://github.com/ollama/ollama/pull/15046/files (20 changed lines in 2 files, Go)
- Commits: base c9b5da6b0c862ccf6c92f89a26aad27442d4c59b, head 0342cde7976220ff925ca9bfe161e0222ba3359b; merged 2026-03-24T23:45:36Z as https://github.com/ollama/ollama/commit/4fda69809a3fecf73d0f71657ef50f8f7e8f43f7
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-22T23:45:36Z (read 2026-10-12): 7 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on .github/workflows/test.yaml: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Later commits on x/imagegen/mlx/CMakeLists.txt: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 42. fix(editor): Fix `/diff` route loading in demo mode

- Case: clean/n8n-io__n8n-27610@5d021fdd
- Change: https://github.com/n8n-io/n8n/pull/27610/files (6 changed lines in 1 file, TypeScript)
- Commits: base d3e45bc126258c86dfcf81282b0e28bc1088bf54, head 7a617e72ad4a46e45ba1b7aa01c72a183d1b8d77; merged 2026-03-26T13:04:26Z as https://github.com/n8n-io/n8n/commit/197a4314b39dc873c6e13fd9cd8164971d53023a
- Licence: NOASSERTION, LICENSE.md (unverified: private runs only)
- Reviews by others: 3 (approved 1, commented 1, dismissed 1); none requested changes
- Checked up to 2026-06-24T13:04:26Z (read 2026-10-12): 15 later commits on its files, 3 reading as a fix, revert or follow-up, none touching its lines
- Later commits on packages/frontend/editor-ui/src/app/composables/useWorkflowInitialization.ts: 15, 12 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-14T11:03:50Z https://github.com/n8n-io/n8n/commit/c9cab112f99a5da2742012773450bf7721484c28 "fix(editor): Show relevant node in workflow activation errors (#26691)": its changes miss the pull request's lines, which sit at 2, 55 to 56, 90 of its parent
  - 2026-05-06T11:42:12Z https://github.com/n8n-io/n8n/commit/bec74aeb4fda198853b3ea82ed135a1db3ba4988 "fix(core): Add workflow structure validation (#29699)": its changes miss the pull request's lines, which sit at 2, 62 to 63, 97 of its parent
  - 2026-05-19T07:51:37Z https://github.com/n8n-io/n8n/commit/21a309015248587edc84fae8c230db0940b05bca "fix(editor): Restore workflow name in window tab title (#29826)": its changes miss the pull request's lines, which sit at 2, 63 to 64, 98 of its parent
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/n8n-io/n8n/pull/27765 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27771 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27772 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27778 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27781 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27786 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27787 ":rocket: Release 2.15.0"; https://github.com/ATHEO-Ingenierie/n8n-helm/pull/32 "Update n8n appVersion to 2.15.0"
- Ruling: 

## 43. fix(core): Add format validation to source control branch name

- Case: clean/n8n-io__n8n-27518@be2e1eb8
- Change: https://github.com/n8n-io/n8n/pull/27518/files (25 changed lines in 2 files, TypeScript)
- Commits: base fc0f0712d8ee07cc259c9757cde44df8da2efe26, head 4f8dd78c8b69a0cba02bdd5b2b73bbccb358b80d; merged 2026-03-25T08:24:38Z as https://github.com/n8n-io/n8n/commit/fb7788d6c286f99126371a33b648c6def9541143
- Licence: NOASSERTION, LICENSE.md (unverified: private runs only)
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-23T08:24:38Z (read 2026-10-12): 1 later commit on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on packages/cli/src/modules/source-control.ee/__tests__/source-control-preferences.service.ee.test.ts: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/n8n-io/n8n/pull/27765 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27771 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27772 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27778 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27781 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27786 ":rocket: Release 2.15.0"; https://github.com/n8n-io/n8n/pull/27787 ":rocket: Release 2.15.0"; https://github.com/ATHEO-Ingenierie/n8n-helm/pull/32 "Update n8n appVersion to 2.15.0"
- Ruling: 

## 44. feat(platform): add processor_merchant_id and created_by to payouts and authentication

- Case: clean/juspay__hyperswitch-11480@8c3676ed
- Change: https://github.com/juspay/hyperswitch/pull/11480/files (176 changed lines in 26 files, Rust)
- Commits: base 7c7c001cd37ba2471931d6cd7c69bd4a803b792a, head 42da838e41af846c38707988f0982df31ed40509; merged 2026-03-13T12:07:24Z as https://github.com/juspay/hyperswitch/commit/19b8f61017eb3bbc62a1cea2483ee9ca1544fc0a
- Licence: Apache-2.0, LICENSE
- Reviews by others: 6 (approved 3, commented 3); none requested changes
- Checked up to 2026-06-11T12:07:24Z (read 2026-10-12): 183 later commits on its files, 19 reading as a fix, revert or follow-up, none touching its lines
- Later commits on crates/diesel_models/src/payout_attempt.rs: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on crates/diesel_models/src/schema.rs: 23, 22 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-26T19:32:15Z https://github.com/juspay/hyperswitch/commit/8c96aa513a2223d9a38535fc00df25c59230d923 "fix(payment_methods): resolve PSP tokenization issue in modular payment methods (#11588)": its changes miss the pull request's lines, which sit at 180 to 183, 1432 to 1435, 1482 to 1485 of its parent
- Later commits on crates/diesel_models/src/schema_v2.rs: 27, 26 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-26T19:32:15Z https://github.com/juspay/hyperswitch/commit/8c96aa513a2223d9a38535fc00df25c59230d923 "fix(payment_methods): resolve PSP tokenization issue in modular payment methods (#11588)": its changes miss the pull request's lines, which sit at 180 to 183, 1377 to 1380, 1427 to 1430 of its parent
- Later commits on crates/hyperswitch_domain_models/src/authentication.rs: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on crates/hyperswitch_domain_models/src/payouts/payout_attempt.rs: 3, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-06-10T06:20:16Z https://github.com/juspay/hyperswitch/commit/dcf9f166aaebc205625186c25293746cc3d84602 "fix(kv): add payout_id to payout_attempt lookup for correct KV partition key resolution (#12613)": its changes miss the pull request's lines, which sit at 5, 103 to 104, 158 to 159 of its parent
- Later commits on crates/hyperswitch_domain_models/src/payouts/payouts.rs: 1
  - 2026-05-12T07:45:58Z https://github.com/juspay/hyperswitch/commit/43c075dfd45818b495ebbfff58c7e0ce2206c5bd "fix(payouts): populate total_count in payout list and filter responses (#11907)": its changes miss the pull request's lines, which sit at 129 to 130, 160 to 161 of its parent
- Later commits on crates/router/src/core/authentication.rs: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on crates/router/src/core/payments.rs: 48, 42 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-26T19:32:15Z https://github.com/juspay/hyperswitch/commit/8c96aa513a2223d9a38535fc00df25c59230d923 "fix(payment_methods): resolve PSP tokenization issue in modular payment methods (#11588)": its changes miss the pull request's lines, which sit at 908 of its parent
  - 2026-04-02T12:38:47Z https://github.com/juspay/hyperswitch/commit/42509f79db159f9816a5e26f974757986a707b64 "fix(router): Rename payment_session to client_session (#11692)": its changes miss the pull request's lines, which sit at 909 of its parent
  - 2026-04-10T11:01:29Z https://github.com/juspay/hyperswitch/commit/9475f642a6b2ff8a958758b43377e0f20da4f230 "fix(core): 3DS Setup Mandate Webhook Trigger Fix (#11771)": its changes miss the pull request's lines, which sit at 920 of its parent
  - 2026-04-13T10:49:42Z https://github.com/juspay/hyperswitch/commit/96a32e23778b3ef21b0124b37025729863613736 "fix(core): Fetch Customer Document Details at Intent (#11211)": its changes miss the pull request's lines, which sit at 920 of its parent
  - 2026-04-14T13:41:04Z https://github.com/juspay/hyperswitch/commit/c7842e0ea040364dee0e58bf38bce5ac631c53bc "fix(payment-methods): fix external sdk token flow (#11779)": its changes miss the pull request's lines, which sit at 922 of its parent
  - 2026-05-05T17:09:00Z https://github.com/juspay/hyperswitch/commit/ef73fade19f26ff246ef026ffbf9417984af3d8c "fix(connector): [Finix] Avs , Err msg , Fraud Session Id (#12077)": its changes miss the pull request's lines, which sit at 919 of its parent
- Later commits on crates/router/src/core/payments/operations.rs: 13, 12 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-13T10:49:42Z https://github.com/juspay/hyperswitch/commit/96a32e23778b3ef21b0124b37025729863613736 "fix(core): Fetch Customer Document Details at Intent (#11211)": its changes miss the pull request's lines, which sit at 419 of its parent
- Later commits on crates/router/src/core/payments/operations/payment_confirm.rs: 32, 30 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T12:38:47Z https://github.com/juspay/hyperswitch/commit/42509f79db159f9816a5e26f974757986a707b64 "fix(router): Rename payment_session to client_session (#11692)": its changes miss the pull request's lines, which sit at 1366, 1400, 1806 to 1807, 1859 to 1860 of its parent
  - 2026-04-13T10:49:42Z https://github.com/juspay/hyperswitch/commit/96a32e23778b3ef21b0124b37025729863613736 "fix(core): Fetch Customer Document Details at Intent (#11211)": its changes miss the pull request's lines, which sit at 1430, 1464, 1870 to 1871, 1923 to 1924 of its parent
- Later commits on crates/router/src/core/payouts.rs: 15, 12 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-15T10:36:24Z https://github.com/juspay/hyperswitch/commit/7864ee21e80dbee00bd6bea37349e9a8d88f1d1d "fix(core/payouts): Fix payouts void logic and response handling for wallets (#10630)": its changes miss the pull request's lines, which sit at 3065 to 3068, 3132 to 3135 of its parent
  - 2026-05-12T07:45:58Z https://github.com/juspay/hyperswitch/commit/43c075dfd45818b495ebbfff58c7e0ce2206c5bd "fix(payouts): populate total_count in payout list and filter responses (#11907)": its changes miss the pull request's lines, which sit at 3122 to 3125, 3203 to 3206 of its parent
  - 2026-06-10T06:20:16Z https://github.com/juspay/hyperswitch/commit/dcf9f166aaebc205625186c25293746cc3d84602 "fix(kv): add payout_id to payout_attempt lookup for correct KV partition key resolution (#12613)": its changes miss the pull request's lines, which sit at 3166 to 3169, 3247 to 3250 of its parent
- Later commits on crates/router/src/core/payouts/retry.rs: 7, 7 with no fix word (listed in suites/clean/candidates.json)
- Later commits on crates/router/src/core/unified_authentication_service.rs: 6, 6 with no fix word (listed in suites/clean/candidates.json)
- Later commits on crates/storage_impl/src/payouts/payout_attempt.rs: 4, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-06-09T05:04:38Z https://github.com/juspay/hyperswitch/commit/26d91c1f5956a94f5aeb46d5e57b4ebc81cc7ef3 "fix(kv): change partition key for PayoutAttempts (#12564)": its changes miss the pull request's lines, which sit at 94 to 95, 616 to 617, 649 to 652, 687 to 688, 720 to 723 of its parent
  - 2026-06-10T06:20:16Z https://github.com/juspay/hyperswitch/commit/dcf9f166aaebc205625186c25293746cc3d84602 "fix(kv): add payout_id to payout_attempt lookup for correct KV partition key resolution (#12613)": its changes miss the pull request's lines, which sit at 94 to 95, 616 to 617, 649 to 652, 687 to 688, 720 to 723 of its parent
- Later commits on crates/storage_impl/src/payouts/payouts.rs: 1
  - 2026-05-12T07:45:58Z https://github.com/juspay/hyperswitch/commit/43c075dfd45818b495ebbfff58c7e0ce2206c5bd "fix(payouts): populate total_count in payout list and filter responses (#11907)": its changes miss the pull request's lines, which sit at 110 to 111, 986 to 987, 1018 to 1021, 1055 to 1056, 1087 to 1090 of its parent
- Ruling: 

## 45. chore(connector): add warning comment about dtd validation to redsys soap api

- Case: clean/juspay__hyperswitch-11384@f5d74230
- Change: https://github.com/juspay/hyperswitch/pull/11384/files (8 changed lines in 1 file, Rust)
- Commits: base 1e7eff50bb83f7462c79c7f2d8505a4457aab553, head 9c8ca148c03db6a8b19d26aaf7782aab5f6de35d; merged 2026-02-27T08:18:01Z as https://github.com/juspay/hyperswitch/commit/03f2f05fdb69fc6324455c5c3e492e6296a09195
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-05-28T08:18:01Z (read 2026-10-12): 4 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on crates/hyperswitch_connectors/src/connectors/redsys/transformers.rs: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Later commits naming it (quoting its title, or with no fix word): https://github.com/juspay/hyperswitch/commit/5c8fab1232d01ba1ffd051772d9bfcd851c171f4 "chore(connector): add warning comment about dtd validation to redsys soap api (#11384)"; https://github.com/juspay/hyperswitch/commit/490ed42e3633658e79d31f0806937ebc854adfac "chore(connector): add warning comment about dtd validation to redsys soap api (#11384)"
- Ruling: 

## 46. Dbeaver/pro#8396 fix delete column in record mode

- Case: clean/dbeaver__dbeaver-40497@361209fd
- Change: https://github.com/dbeaver/dbeaver/pull/40497/files (6 changed lines in 2 files, Java)
- Commits: base 0f43c2ea7d30c66343ce92ba15f7ecaa568992c1, head 1869da30350098b2661e809a21610d9066421ed4; merged 2026-03-12T10:54:56Z as https://github.com/dbeaver/dbeaver/commit/21c452c51e41d91a12f25a4a3e72f0dba6b0aa0d
- Licence: Apache-2.0, LICENSE.md
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-10T10:54:56Z (read 2026-10-12): 9 later commits on its files, 3 reading as a fix, revert or follow-up, none touching its lines
- Later commits on plugins/org.jkiss.dbeaver.ui.editors.data/src/org/jkiss/dbeaver/ui/controls/resultset/ResultSetPersister.java: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on plugins/org.jkiss.dbeaver.ui.editors.data/src/org/jkiss/dbeaver/ui/controls/resultset/ResultSetViewer.java: 8, 5 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-28T13:12:34Z https://github.com/dbeaver/dbeaver/commit/aa70ac7dcbc5b52fad66b19f80c588ce1eefa373 "dbeaver/pro#8775 Fix record mode for composites and arrays (#40923)": its changes miss the pull request's lines, which sit at 125 to 127, 4905 of its parent
  - 2026-04-28T13:54:56Z https://github.com/dbeaver/dbeaver/commit/e601e91ac7c8f751d9a48969d928ef4383e8622a "dbeaver/pro#3295 Fix referenced column filter update in the References panel (#40930)": its changes miss the pull request's lines, which sit at 125 to 127, 4908 of its parent
  - 2026-05-21T14:34:20Z https://github.com/dbeaver/dbeaver/commit/1f8ad0bedef1cc98c029f0de7f84d42044d68f3c "dbeaver/pro#9354 Fix array size hint in record mode (#41129)": its changes miss the pull request's lines, which sit at 127 to 128, 4916 of its parent
- Ruling: 

## 47. Support Codex CLI stdin piping for `codex exec`

- Case: clean/openai__codex-15917@b980f8c2
- Change: https://github.com/openai/codex/pull/15917/files (311 changed lines in 5 files, Rust)
- Commits: base 44d28f500f7f21fa13f0e9eea87544a6269efde7, head 2b2d4b2a39d2dc8651b16cede5715ac295a5bdc1; merged 2026-03-28T02:21:23Z as https://github.com/openai/codex/commit/71923f43a7ef8ed02531a885228257e9c5b87c7b
- Licence: Apache-2.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-26T02:21:23Z (read 2026-10-12): 106 later commits on its files, 9 reading as a fix, revert or follow-up, none touching its lines
- Later commits on codex-rs/README.md: 8, 6 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-25T06:31:47Z https://github.com/openai/codex/commit/a2db6f97fb9353edfbcb82ea4fbb89c8346d1222 "Fix codex-rs README grammar (#19514)": its changes miss the pull request's lines, which sit at 53 of its parent
  - 2026-05-05T17:34:44Z https://github.com/openai/codex/commit/13be504063ed94a494267eefb7a24cc452c58c83 "revert legacy notify deprecation (#21152)": its changes miss the pull request's lines, which sit at 53 of its parent
- Later commits on codex-rs/exec/src/cli.rs: 9, 7 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-06T05:09:19Z https://github.com/openai/codex/commit/d9b899309dbba0921350bb7f8d947dbf3efec48d "Fix misleading codex exec help usage (#16881)": its changes miss the pull request's lines, which sit at 108 to 109 of its parent
  - 2026-04-20T23:12:17Z https://github.com/openai/codex/commit/0f1c9b896308d8a8b45ba957f6bbe9f8f50c7b80 "Fix exec inheritance of root shared flags (#18630)": its changes miss the pull request's lines, which sit at 119 to 120 of its parent
- Later commits on codex-rs/exec/src/lib.rs: 85, 80 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-06T15:45:58Z https://github.com/openai/codex/commit/fb41a79f3769381a14a5cf1d4b4ec75352bf7856 "[regression] Fix ephemeral turn backfill in exec (#16795)": its changes miss the pull request's lines, which sit at 123 to 134, 630, 1546 to 1547, 1549 to 1564, 1566 to 1570, 1572 to 1584, 1587 to 1591, 1593 to 1612, 1614 to 1617, 1619 to 1628 of its parent
  - 2026-04-11T00:00:58Z https://github.com/openai/codex/commit/b114781495f97aa11d2831f81f27f2634842ab24 "fix(permissions): fix symlinked writable roots in sandbox permissions (#15981)": its changes miss the pull request's lines, which sit at 159 to 170, 1622 to 1623, 1625 to 1640, 1642 to 1646, 1648 to 1660, 1663 to 1667, 1669 to 1688, 1690 to 1693, 1695 to 1704 of its parent
  - 2026-04-11T06:08:02Z https://github.com/openai/codex/commit/e9e7ef3d366fdb95c24d24fea734b0fa47d79fc4 "Fix thread/list cwd filtering for Windows verbatim paths (#17414)": its changes miss the pull request's lines, which sit at 160 to 171, 1625 to 1626, 1628 to 1643, 1645 to 1649, 1651 to 1663, 1666 to 1670, 1672 to 1691, 1693 to 1696, 1698 to 1707 of its parent
  - 2026-04-15T19:25:53Z https://github.com/openai/codex/commit/7e7b35b4d296cd19280b5468814323db0d68c1a7 "fix: propagate log db (#17953)": its changes miss the pull request's lines, which sit at 161 to 172, 1628 to 1629, 1631 to 1646, 1648 to 1652, 1654 to 1666, 1669 to 1673, 1675 to 1694, 1696 to 1699, 1701 to 1710 of its parent
  - 2026-04-20T23:12:17Z https://github.com/openai/codex/commit/0f1c9b896308d8a8b45ba957f6bbe9f8f50c7b80 "Fix exec inheritance of root shared flags (#18630)": its changes miss the pull request's lines, which sit at 161 to 172, 1641 to 1642, 1644 to 1659, 1661 to 1665, 1667 to 1679, 1682 to 1686, 1688 to 1707, 1709 to 1712, 1714 to 1723 of its parent
- Later commits on codex-rs/exec/tests/suite/mod.rs: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on codex-rs/exec/tests/suite/prompt_stdin.rs: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 48. docs(vector): add basic docs about vector drawing

- Case: clean/lvgl__lvgl-9888@2f9ccc14
- Change: https://github.com/lvgl/lvgl/pull/9888/files (60 changed lines in 3 files, C)
- Commits: base 556bd623c3280aad360b7e52ce09a9f6be056dd0, head ac5d4811e830fa0e3980ee4af7948b1eaba69bd2; merged 2026-03-24T21:44:30Z as https://github.com/lvgl/lvgl/commit/af113e2f1e6dd1ecd867513e8a3b5497effa7124
- Licence: MIT, LICENCE.txt
- Reviews by others: 3 (approved 1, commented 2); none requested changes
- Checked up to 2026-06-22T21:44:30Z (read 2026-10-12): 4 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on docs/src/main-modules/draw/draw_descriptors.rst: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on src/draw/lv_draw_vector.h: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on src/widgets/chart/lv_chart.c: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 49. Examples: Add SSGI Ball Pool demo.

- Case: clean/mrdoob__three.js-33258@487fa360
- Change: https://github.com/mrdoob/three.js/pull/33258/files (515 changed lines in 5 files, JavaScript)
- Commits: base 61184846352941d0684167aa343467c9c2a384a2, head 403b00cd38a42f7734a39bb5e601ff1cd71d48d1; merged 2026-03-29T08:43:21Z as https://github.com/mrdoob/three.js/commit/82b371fb82bf9b39bc15818d4f66a430c19d5ac1
- Licence: MIT, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-27T08:43:21Z (read 2026-10-12): 51 later commits on its files, 4 reading as a fix, revert or follow-up, none touching its lines
- Later commits on examples/files.json: 22, 21 with no fix word (listed in suites/clean/candidates.json)
  - 2026-06-21T21:15:44Z https://github.com/mrdoob/three.js/commit/78b7608226b43d81a3c0523de2783b2534de676c "GLTFExporter: Fix export of normal maps. (#33837)": its changes miss the pull request's lines, which sit at 447 of its parent
- Later commits on examples/tags.json: 7, 7 with no fix word (listed in suites/clean/candidates.json)
- Later commits on examples/webgpu_postprocessing_ssgi_ballpool.html: 5, 5 with no fix word (listed in suites/clean/candidates.json)
- Later commits on test/e2e/puppeteer.js: 17, 14 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-20T10:58:09Z https://github.com/mrdoob/three.js/commit/36599a7a3ac44404e0ebd79feb3c5ffee306222a "NodeMaterialObserver: Fix default version value of textures. (#33422)": its changes miss the pull request's lines, which sit at 28 of its parent
  - 2026-05-27T00:52:16Z https://github.com/mrdoob/three.js/commit/d5efabcfe68f5a98d04aaa74f94ea1ae98233181 "E2E: Fix WebGPU Device Lost errors (#33650)": its changes miss the pull request's lines, which sit at 28 of its parent
  - 2026-06-22T12:55:30Z https://github.com/mrdoob/three.js/commit/e4fd65b763656c7bcdaf5c45b8b459358079f27a "RenderObject: Fix handling of `side`. (#33860)": its changes miss the pull request's lines, which sit at 28 of its parent
- Ruling: 

## 50. Fix ZDIFF algorithm 2 memory leak on early exit

- Case: clean/valkey-io__valkey-3342@29993a20
- Change: https://github.com/valkey-io/valkey/pull/3342/files (13 changed lines in 2 files, C)
- Commits: base 5deebd0f131826124b3ab6231fafb5f9b188523b, head daa115a760d9cbb00bfac57b1ab3bd0af436e7d1; merged 2026-03-11T02:34:15Z as https://github.com/valkey-io/valkey/commit/6b384e9a5b6cd4e4f8198f5df22a74feb1b70e0f
- Licence: BSD-3-Clause, COPYING
- Reviews by others: 3 (approved 3); none requested changes
- Checked up to 2026-06-09T02:34:15Z (read 2026-10-12): 3 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/t_zset.c: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits naming it (quoting its title, or with no fix word): https://github.com/valkey-io/valkey/commit/27dd874834fd181f3517d0874cf2406da977ad60 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/6fd227f7a3306ac264a0aac427ab18cdf6ba7a17 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/614351040cab1b77532aec9fbf913f28ddda17f9 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/830d1fecb54d758869ef3f48efd3ff9e325ba2dc "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/4a3714ba93dd2dde3d6364ee6368672e04244518 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/7c33dca93ba13038ff10868ed5ba223b4ef09d54 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"; https://github.com/valkey-io/valkey/commit/e77aa946c4fe89bd17aee9b36be8576f890183c5 "Fix ZDIFF algorithm 2 memory leak on early exit (#3342)"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/sarthakaggarwal97/valkey/pull/117 "[backport] Weekly backport sweep for 8.1"; https://github.com/sarthakaggarwal97/valkey/pull/234 "[backport] Weekly backport sweep for 7.2"; https://github.com/sarthakaggarwal97/valkey/pull/235 "[backport] Weekly backport sweep for 8.0"; https://github.com/valkey-io/valkey/pull/3735 "[backport][validation failed] Backport sweep for 9.0"; https://github.com/valkey-io/valkey/pull/3737 "[backport] Backport sweep for 8.1"; https://github.com/valkey-io/valkey/pull/3736 "[backport] Backport sweep for 8.0"; https://github.com/valkey-io/valkey/pull/3738 "[backport] Backport sweep for 7.2"; https://github.com/valkey-io/valkey/pull/3879 "[backport] Backport sweep for 9.0"; https://github.com/sarthakaggarwal97/valkey/pull/286 "[backport] Backport sweep for 7.2"
- Ruling: 

## 51. Various song select class cleanup

- Case: clean/ppy__osu-36745@dc460c58
- Change: https://github.com/ppy/osu/pull/36745/files (775 changed lines in 10 files, C#)
- Commits: base e2cbfb970ee24ef04a716f83fb3d22798146a983, head fabce18552a63745b6ae2839c0ebfa136e5af0ce; merged 2026-02-24T12:24:18Z as https://github.com/ppy/osu/commit/5602281bd9e75685f660272e249ee703234d8a55
- Licence: MIT, LICENCE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-05-25T12:24:18Z (read 2026-10-12): 18 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on osu.Game.Tests/Visual/Multiplayer/TestSceneMultiplayer.cs: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on osu.Game.Tests/Visual/Playlists/TestScenePlaylistsRoomSubScreen.cs: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later commits on osu.Game/Screens/OnlinePlay/Multiplayer/MultiplayerMatchSongSelect.cs: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Later commits on osu.Game/Screens/OnlinePlay/Multiplayer/MultiplayerMatchSubScreen.cs: 5, 5 with no fix word (listed in suites/clean/candidates.json)
- Later commits on osu.Game/Screens/OnlinePlay/OnlinePlayFreestyleSelect.cs: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later commits on osu.Game/Screens/OnlinePlay/Playlists/PlaylistsRoomSubScreen.cs: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/LumpBloom7/sentakki/pull/780 "Bump ppy.osu.Game from 2026.213.0 to 2026.303.0"; https://github.com/GooGuTeam/osu-performance-server/pull/31 "Bump the osu-game group with 5 updates"; https://github.com/taulazer/tau/pull/564 "Bump ppy.osu.Game from 2026.213.0 to 2026.303.0"; https://github.com/GooGuTeam/custom-rulesets/pull/31 "Bump the osu-game group with 5 updates"; https://github.com/Rudicito/gitaroo/pull/76 "Bump ppy.osu.Game from 2026.119.0 to 2026.303.0"; https://github.com/goodtrailer/soyokaze/pull/249 "Bump ppy.osu.Game from 2026.102.0 to 2026.303.0"; https://github.com/taulazer/tau/pull/571 "Bump ppy.osu.Game from 2026.213.0 to 2026.303.0"; https://github.com/LumpBloom7/hishigata/pull/315 "Bump ppy.osu.Game from 2025.1029.0 to 2026.303.0"; https://github.com/Rudicito/gitaroo/pull/77 "Bump ppy.osu.Game from 2026.119.0 to 2026.315.0"; https://github.com/goodtrailer/soyokaze/pull/250 "Bump ppy.osu.Game from 2026.102.0 to 2026.315.0"; https://github.com/GooGuTeam/osu-performance-server/pull/33 "Bump the osu-game group with 5 updates"; https://github.com/GooGuTeam/custom-rulesets/pull/32 "Bump the osu-game group with 5 updates"; https://github.com/Rudicito/gitaroo/pull/78 "Bump ppy.osu.Game from 2026.119.0 to 2026.317.0"; https://github.com/goodtrailer/soyokaze/pull/251 "Bump ppy.osu.Game from 2026.102.0 to 2026.317.0"; https://github.com/GooGuTeam/osu-performance-server/pull/34 "Bump the osu-game group with 5 updates"; https://github.com/Game4all/gamebosu/pull/287 "Bump ppy.osu.Game from 2025.816.0 to 2026.408.0"; https://github.com/Game4all/gamebosu/pull/289 "Bump ppy.osu.Game from 2025.816.0 to 2026.429.0"; https://github.com/Game4all/gamebosu/pull/291 "Bump ppy.osu.Game from 2025.816.0 to 2026.505.0"
- Ruling: 

## 52. doc: clarify confusing `git range-diff` add/delete output

- Case: clean/bitcoin__bitcoin-34656@107d85ce
- Change: https://github.com/bitcoin/bitcoin/pull/34656/files (13 changed lines in 1 file, C++)
- Commits: base ab8a7af74209e5d58203af14d9133d14de6a5776, head 45133c589a970390bc10e4db4f7d9921dbaa0832; merged 2026-02-27T10:21:45Z as https://github.com/bitcoin/bitcoin/commit/3c7b0f97e0f6384824ec387861a2e88dc4cd737a
- Licence: MIT, COPYING
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-05-28T10:21:45Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

## 53. Deflake Restart target replica during migration (without save) causes success test

- Case: clean/valkey-io__valkey-3226@a1cd5c3b
- Change: https://github.com/valkey-io/valkey/pull/3226/files (20 changed lines in 1 file, C)
- Commits: base 4dee322edeb9c96029d89cfaf1600abad2afead0, head feeb16034cd1cf93533083f879506e45e5c914b3; merged 2026-02-27T02:42:50Z as https://github.com/valkey-io/valkey/commit/75fb0e6cbb7ce7e6762951b6b97083c433e5b4c1
- Licence: BSD-3-Clause, COPYING
- Reviews by others: 7 (approved 6, commented 1); none requested changes
- Checked up to 2026-05-28T02:42:50Z (read 2026-10-12): 2 later commits on its files, 1 reading as a fix, revert or follow-up, none touching its lines
- Later commits on tests/unit/cluster/cluster-migrateslots.tcl: 2, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-08T08:26:29Z https://github.com/valkey-io/valkey/commit/dba128f13b7486322fe3b52a8358bd9188ec613a "Fix slot-migration-max-failover-repl-bytes unable to accept -1 (#3443)": its changes miss the pull request's lines, which sit at 2095 to 2099, 2108 to 2112, 2120 to 2125 of its parent
- Ruling: 

## 54. Changelog for v0.35.3

- Case: clean/google-gemini__gemini-cli-24083@4d345603
- Change: https://github.com/google-gemini/gemini-cli/pull/24083/files (9 changed lines in 1 file, TypeScript)
- Commits: base 07ab16dbbee77faabf38b5ecf05ae4ef9d8e9fa1, head 643623f51c3b11fcee2a4ea8c0f9ae8a5f022685; merged 2026-03-31T06:53:19Z as https://github.com/google-gemini/gemini-cli/commit/e293424bb4973fc2a281f67c43594222263b240a
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-29T06:53:19Z (read 2026-10-12): 14 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on docs/changelogs/latest.md: 14, 14 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 55. feat(cli): add rotating feature tips during thinking/acting phases

- Case: clean/cline__cline-9874@9cf28e41
- Change: https://github.com/cline/cline/pull/9874/files (124 changed lines in 2 files, TypeScript)
- Commits: base f3a3f30db5bd616cb055ba029d78e5f9fcefb451, head d9bdb9a820c2647203c8d54ca0059f7426d1d50e; merged 2026-03-25T00:57:35Z as https://github.com/cline/cline/commit/e807b520e0cf3e0a5ff01091ea5d86a421e4d749
- Licence: Apache-2.0, LICENSE
- Reviews by others: 2 (approved 1, commented 1); none requested changes
- Checked up to 2026-06-23T00:57:35Z (read 2026-10-12): 5 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on cli/src/components/FeatureTip.tsx: 3, 3 with no fix word (listed in suites/clean/candidates.json)
- Later commits on cli/src/components/ThinkingIndicator.tsx: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 56. fix(mobile): mismatch between system and app color when using low-chroma system color scheme

- Case: clean/immich-app__immich-27282@3e94b6c2
- Change: https://github.com/immich-app/immich/pull/27282/files (12 changed lines in 1 file, TypeScript)
- Commits: base e2d26ebdea86c8157017602b64fc4019fb24c842, head 51ce41f373f41d6bce0eb9aa8d53e0eae33d9a82; merged 2026-03-27T14:21:44Z as https://github.com/immich-app/immich/commit/be0fc403d807bca0556e46d18193ca5e7e72de39
- Licence: AGPL-3.0, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-25T14:21:44Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

## 57. vo_gpu_next: add scRGB support

- Case: clean/mpv-player__mpv-17505@c0be1221
- Change: https://github.com/mpv-player/mpv/pull/17505/files (58 changed lines in 6 files, C)
- Commits: base a9ac97a5b04868472b8fed4d80bd8d92fef8d617, head 0fe2d243f77667dc19391ee0f46a868213fa8d0d; merged 2026-03-06T15:17:58Z as https://github.com/mpv-player/mpv/commit/f9190e57f9d29a7a387b2b9f49671ebf19ea09bd
- Licence: NOASSERTION, LICENSE.GPL (unverified: private runs only)
- Reviews by others: 2 (commented 2); none requested changes
- Checked up to 2026-06-04T15:17:58Z (read 2026-10-12): 64 later commits on its files, 6 reading as a fix, revert or follow-up, none touching its lines
- Later commits on DOCS/man/options.rst: 40, 36 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-16T15:18:42Z https://github.com/mpv-player/mpv/commit/a9e1ce9c0da2a67ba28cd98b1676cb950805518f "DOCS/man/options: fix description for testing with all hwdec methods": its changes miss the pull request's lines, which sit at 6288 to 6289, 7304 to 7309 of its parent
  - 2026-04-17T17:44:15Z https://github.com/mpv-player/mpv/commit/7f81e1ec8cb1fbb572078b7ce90979e567ea808e "vo_gpu_next: fix image subtitle hdr peak": its changes miss the pull request's lines, which sit at 6288 to 6289, 7304 to 7309 of its parent
  - 2026-05-16T03:26:02Z https://github.com/mpv-player/mpv/commit/779378c248495ee10bcb2fa805e1e47e12bd8bef "docs/comments: fix doubled-word typos": its changes miss the pull request's lines, which sit at 6320 to 6321, 7380 to 7385 of its parent
  - 2026-05-18T14:47:14Z https://github.com/mpv-player/mpv/commit/35ae76daad738ac31621c8c7f56300d7e99d1c43 "docs/comments: fix more doubled-word typos": its changes miss the pull request's lines, which sit at 6389 to 6390, 7449 to 7454 of its parent
- Later commits on video/csputils.c: 4, 4 with no fix word (listed in suites/clean/candidates.json)
- Later commits on video/out/gpu/d3d11_helpers.c: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits on video/out/vo_gpu_next.c: 19, 17 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-17T17:44:15Z https://github.com/mpv-player/mpv/commit/7f81e1ec8cb1fbb572078b7ce90979e567ea808e "vo_gpu_next: fix image subtitle hdr peak": its changes miss the pull request's lines, which sit at 947, 1212, 1284 to 1292 of its parent
  - 2026-05-03T06:47:34Z https://github.com/mpv-player/mpv/commit/7c25b3e47cce3daf86b22dec95231ab3869e1273 "vo_gpu_next: fix upload synchronization": its changes miss the pull request's lines, which sit at 952, 1227, 1299 to 1307 of its parent
- Ruling: 

## 58. GLSLDecoder: Replace deprecated `substr()` with `slice()`.

- Case: clean/mrdoob__three.js-33260@89866e8c
- Change: https://github.com/mrdoob/three.js/pull/33260/files (4 changed lines in 1 file, JavaScript)
- Commits: base 02de89f05a72761a06adb4ccc78200b8f8208ac8, head e78b92bf148af75c918773c2622afaa74e5eefd4; merged 2026-03-28T08:33:00Z as https://github.com/mrdoob/three.js/commit/f0a65ef67e50d3c6ee158d2198b8fe6910484479
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-26T08:33:00Z (read 2026-10-12): 1 later commit on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on examples/jsm/transpiler/GLSLDecoder.js: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 59. middleware: enable local tool model for web search

- Case: clean/ollama__ollama-14787@99e6582b
- Change: https://github.com/ollama/ollama/pull/14787/files (62 changed lines in 2 files, Go)
- Commits: base c222735c02a3fda18cdbd05ccae2d5dc1a290b42, head a85b62db0a0a822faa9871a0b5cd1cc4a8f7fdf7; merged 2026-03-11T21:51:39Z as https://github.com/ollama/ollama/commit/8f45236d09332949aa91774dc9eb46caf2abbbc1
- Licence: MIT, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-09T21:51:39Z (read 2026-10-12): 3 later commits on its files, 2 reading as a fix, revert or follow-up, none touching its lines
- Later commits on middleware/anthropic.go: 2, 1 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-27T21:30:16Z https://github.com/ollama/ollama/commit/ac83ac20c444656f0f7d5bbad5b62da389395439 "anthropic: fix KV cache reuse degraded by tool call argument reordering": its changes miss the pull request's lines, which sit at 243 to 244 of its parent
- Later commits on middleware/anthropic_test.go: 1
  - 2026-03-27T21:30:16Z https://github.com/ollama/ollama/commit/ac83ac20c444656f0f7d5bbad5b62da389395439 "anthropic: fix KV cache reuse degraded by tool call argument reordering": its changes miss the pull request's lines, which sit at 1647 to 1675, 1716 to 1726, 1728 to 1729, 1731 to 1732 of its parent
- Ruling: 

## 60. fix linux profile detection for chromium users

- Case: clean/browser-use__browser-use-4512@67cff2e8
- Change: https://github.com/browser-use/browser-use/pull/4512/files (8 changed lines in 2 files, Python)
- Commits: base 872ef3982dfbb8888588cddedecd341fbad34ead, head e44ce7ce732b9da9dd1c7e0916d8a4af7e0df6ba; merged 2026-03-24T22:28:34Z as https://github.com/browser-use/browser-use/commit/c8779d242db8394372ffd7e51f3f7ede7ca83ac1
- Licence: MIT, LICENSE
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-22T22:28:34Z (read 2026-10-12): 15 later commits on its files, 10 reading as a fix, revert or follow-up, none touching its lines
- Later commits on browser_use/browser/session.py: 8, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-03-25T23:34:25Z https://github.com/browser-use/browser-use/commit/4c883feb7c6f9d71600818b94e0f4a5359651362 "Merge branch 'main' into fix/cloud-session-stop-cdp-reconnect": a merge into another branch: its first parent does not hold the pull request
  - 2026-03-31T18:19:43Z https://github.com/browser-use/browser-use/commit/5e644981e82cc1276aca768b27df54155d9ddc3c "fix: close CloudBrowserClient httpx pool on session stop to prevent memory leak": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-04-12T21:45:44Z https://github.com/browser-use/browser-use/commit/76604913ad0ca43cc4797da338a395a3e5ea9bb4 "Merge branch 'main' into fix/browser-session-close": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-04-21T00:40:32Z https://github.com/browser-use/browser-use/commit/9a09c4d7dc634a26bc9cf8a4e6d5695682d6f426 "fix(cdp): timeout-wrap CDPClient.send_raw to break silent WebSocket hangs": its changes miss the pull request's lines, which sit at 412 of its parent
  - 2026-05-18T18:23:41Z https://github.com/browser-use/browser-use/commit/9a6510a85cf1df93e0dd1f6555fac12688d33e37 "fix: respect proxy_country_code=None to disable proxy in cloud mode": its changes miss the pull request's lines, which sit at 413 of its parent
- Later commits on browser_use/skill_cli/utils.py: 7, 2 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-02T01:24:41Z https://github.com/browser-use/browser-use/commit/b92c7486bfe65bb5d14c2d2ab1edfaa8be141429 "fix: remove 9229 from Chrome CDP port probing (Node.js debugger port, not Chrome)": its changes miss the pull request's lines, which sit at 128 to 132 of its parent
  - 2026-04-03T00:41:15Z https://github.com/browser-use/browser-use/commit/a05a053da63498bb5a6865422f0e7cbe88175b71 "fix: add per-session auth token to daemon socket to prevent unauthorized code execution": its changes miss the pull request's lines, which sit at 128 to 132 of its parent
  - 2026-04-14T18:23:50Z https://github.com/browser-use/browser-use/commit/d0fbf4c5807a2904e19ac2c1468d2639189a8f26 "improve connect failure UX: fix chrome://inspect link and add fallback guidance": its changes miss the pull request's lines, which sit at 133 to 137 of its parent
  - 2026-04-15T17:07:51Z https://github.com/browser-use/browser-use/commit/4c2d136de9d22af9ab53e807f3064341b75d7687 "fix: add utf-8 encoding to Local State file read in list_chrome_profiles": every line of the pull request in the file was already rewritten before this commit
  - 2026-04-15T20:06:56Z https://github.com/browser-use/browser-use/commit/9c314e626ecf6f24c36903ceb3c161ae919e75f1 "Merge branch 'main' into fix/local-state-utf8-encoding": a merge into another branch: its first parent does not hold the pull request
- Ruling: 

## 61. Starknet loopback client

- Case: clean/unionlabs__union-5384@a78ba723
- Change: https://github.com/unionlabs/union/pull/5384/files (552 changed lines in 9 files, Rust)
- Commits: base df020f8061bce193f651089c0ec776141a1a1e83, head 86cc328fe48bdbc6d76f430e06b006296cc34a42; merged 2026-01-15T09:16:36Z as https://github.com/unionlabs/union/commit/892e9f565c8f1a0c4638235518b0e3907e974b20
- Licence: Apache-2.0, LICENSE-APACHE
- Reviews by others: 2 (approved 2); none requested changes
- Checked up to 2026-04-15T09:16:36Z (read 2026-10-12): 1 later commit on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on Scarb.toml: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 62. fix(voyager): fix race condition with multiple voyagers updating the same client

- Case: clean/unionlabs__union-5396@6a346443
- Change: https://github.com/unionlabs/union/pull/5396/files (10 changed lines in 1 file, Rust)
- Commits: base 6cbbb4f8ae3334e66f1d45ccf6be5a6aa258731f, head 5fbfd93cb30623e450fbf901c64dfda0f0af3c11; merged 2026-01-20T12:04:08Z as https://github.com/unionlabs/union/commit/00ccdd10156f985d700a8fbebd93c648e67c8a0f
- Licence: Apache-2.0, LICENSE-APACHE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-04-20T12:04:08Z (read 2026-10-12): 1 later commit on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on voyager/plugins/transaction-batch/src/callback.rs: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Ruling: 

## 63. BIM: baseless ArchComponent should not lose shape

- Case: clean/FreeCAD__FreeCAD-28742@ff452fa9
- Change: https://github.com/FreeCAD/FreeCAD/pull/28742/files (45 changed lines in 2 files, C++)
- Commits: base ffb07e2f1a51029697aaac024214e26c6112b48e, head e56c8fb831fe53757972637488b65aeb6f3f3cfc; merged 2026-03-30T16:37:27Z as https://github.com/FreeCAD/FreeCAD/commit/c1668389ed1eeec3525df5e1a263b7071b7581fb
- Licence: LGPL-2.1, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-28T16:37:27Z (read 2026-10-12): 6 later commits on its files, 2 reading as a fix, revert or follow-up, none touching its lines
- Later commits on src/Mod/BIM/ArchComponent.py: 5, 3 with no fix word (listed in suites/clean/candidates.json)
  - 2026-04-12T18:52:41Z https://github.com/FreeCAD/FreeCAD/commit/77125665398810c8e23d1ecadff8ec7a3fdadaf8 "BIM: fix Material property pulling into Part container (#28358) (#29262)": its changes miss the pull request's lines, which sit at 378 to 379, 382 to 383, 400 of its parent
  - 2026-05-31T07:18:28Z https://github.com/FreeCAD/FreeCAD/commit/dda08980055fa9e1a0dcc30da7e8757c47fc73f8 "BIM: fix faulty Presets paths (#29913)": its changes miss the pull request's lines, which sit at 402 to 403, 406 to 407, 424 of its parent
- Later commits on src/Mod/BIM/bimtests/TestArchComponent.py: 1, 1 with no fix word (listed in suites/clean/candidates.json)
- Later commits naming it (quoting its title, or with no fix word): https://github.com/FreeCAD/FreeCAD/commit/8ebeb55ec11ccf71ac8c2d3a2f07ef1956c5db51 "[Backport releases/FreeCAD-1-1] BIM: baseless ArchComponent should not lose shape (#28895)"
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/FreeCAD/FreeCAD/pull/28895 "[Backport releases/FreeCAD-1-1] BIM: baseless ArchComponent should not lose shape"
- Ruling: 

## 64. Build:Remove self-signing code and certs

- Case: clean/FreeCAD__FreeCAD-28717@b34ee5e4
- Change: https://github.com/FreeCAD/FreeCAD/pull/28717/files (5 changed lines in 4 files, C++)
- Commits: base bd3ab8dbd3143348e8ab7a4a16a8d3e6dc452d43, head c0b398e0573c393370d6b8f82af0805798fe0849; merged 2026-03-27T09:43:48Z as https://github.com/FreeCAD/FreeCAD/commit/57847b86200708f6739e8ff683e15708e3be2103
- Licence: LGPL-2.1, LICENSE
- Reviews by others: 1 (approved 1); none requested changes
- Checked up to 2026-06-25T09:43:48Z (read 2026-10-12): 2 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Later commits on package/WindowsInstaller/FreeCAD-installer.nsi: 2, 2 with no fix word (listed in suites/clean/candidates.json)
- Later issues and pull requests linking it (no bug label or fix word): https://github.com/FreeCAD/FreeCAD/pull/28738 "[Backport releases/FreeCAD-1-1] Build:Remove self-signing code and certs"
- Ruling: 

## 65. dbeaver/pro#8260 Add `SMTokenInfo` class and `readAccessTokenInfo` me…

- Case: clean/dbeaver__dbeaver-40558@dc4d7837
- Change: https://github.com/dbeaver/dbeaver/pull/40558/files (89 changed lines in 2 files, Java)
- Commits: base 07a18b4e21a9486768969388bb4163382f1be88f, head c165dc827ea3fa6407e77b2550d8db2157d2beb8; merged 2026-03-24T09:56:15Z as https://github.com/dbeaver/dbeaver/commit/83a960ceeb727a4ded2e34cf26b097140d6da2dc
- Licence: Apache-2.0, LICENSE.md
- Reviews by others: 1 (commented 1); none requested changes
- Checked up to 2026-06-22T09:56:15Z (read 2026-10-12): 0 later commits on its files, 0 reading as a fix, revert or follow-up, none touching its lines
- Ruling: 

