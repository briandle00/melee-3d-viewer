# melee-sim-light patches, round 3 (stage joints, fighter joints, the yo-yo's string)

Based on `visual-only/04-shake` at `f1eb1a73` (briandle00/melee-sim-light). Ten commits, one change each, as one series:

- 0001 is the dynamics-counts fix (the same change as `docs/cloud-patches/dynamics-counts/`). It comes first so the swinging chains are solved with the file's driven-joint counts before `fj` records those joints (Peach's and Zelda's chains).
- 0002 to 0013 are in the viewer track, so they compile only with `MSL_VISUAL_TRACK_BUILD=1`.

To apply, from a clone of briandle00/melee-sim-light:

```
git checkout -b cloud/round3-track origin/visual-only/04-shake
git am /path/to/docs/cloud-patches/round3/*.patch
```

No patch contains game data.

**Checked for the whole series (no game data):**
- The production native build (`make native`) at the series head is byte-identical to the build after 0001 alone (`cmp` of `melee-core-native`, both built with the same `BUILD_ROOT`, which the binary embeds). So 0002 to 0004 change nothing in production. 0001 changes it as the dynamics-counts README says (its 3 visual-state locks need regenerating with game data).
- The `MSL_VISUAL_TRACK_BUILD=1` native build compiles without warnings.
- `make source-check` passes.
- `pytest tests`: the same 63 failures and 51 skips as on the base. All of them need `data/` or the replays' LFS objects, which are not in this session.
- There are no synthetic C tests for the viewer track in the repo: it runs only inside a match, which needs game data. So the viewer side has the format tests instead (synthetic track text, in the viewer's `tests/`).

## 0001 Dynamics: chain-joint counts

See `docs/cloud-patches/dynamics-counts/README.md`. Unchanged.

## 0002 Viewer track: stage joints ("sp")

`[frame,"sp",part,(joint,mask,values)...]`

Every stage part with a joint tree in the stage's file writes its joints as the frame's end left them. The nine values are those of `jp`: rot x, y, z, scale x, y, z, translate x, y, z, with mask bit k meaning value k follows. A joint is written once it leaves the file's rest pose, then whenever it changes, as `jp` does.

- **Part number.** The same number `gjoint` uses (`stage_joint`): the part's `map_id`, or `map_id + 1000 * k` for the k-th extra copy that is not the one in `stage_info.x180`.
- **Joint number.** The preorder index `stage_joint` counts. Index 0 is the part's scale root from `Ground_801C14D0`/`get_jobj_inline`, at rest rot 0, scale the stage's (`stage_info.param->x0`, else 1), translate 0. The file's tree (`grDatFiles_801C6330(map_id)->unk4->unk8[map_id].unk0`) starts at 1. An instance's children are not counted.
- **Not written:** quaternion joints, joints past 512, and parts with no tree in the file.
- The pose owners go from 64 to 128 and the line buffer from 48 KB to 256 KB, to fit a stage part's tree. Both are allocated once with the track.
- `sp` is added to `UNLOCKED_KINDS`, so the visual-state locks don't change.

**Needs game data:** check the lines against Dolphin's draws on Fountain of Dreams, Yoshi's Story and Pokemon Stadium. Also measure how much an animated background adds to a track's size. Every joint an animation moves is written on every frame it moves.

## 0003 Viewer track: fighter joints as the game left them ("fj")

`[frame,"fj",port,sub,character,(part,mask,values)...]`

A fighter's joints at the frame's end, by part, with the same nine values. This covers the animation, the blend into it (`ftAnim_8006FE9C`, `ftAnim_80070010`), and whatever the game's own code set afterwards (ftParts, the state's code, the swinging chains). The values are the exact rotate/scale/translate bits, so a viewer rebuilds `jobj->mtx` with `HSD_JObjMakeMatrix` and gets the game's matrix.

**Format chosen.** Every live part, with each value written only when it changes. The fighter's first line, and its first line as another character, has every value. It does not use a "differs from the file animation" baseline. In the hosted build, `ftAnim_8006EBA4` and the blends run more than once a frame in some states, so there is no single moment to snapshot "the file's animation". A baseline would also only help if the viewer's own animation matched bit for bit, which is the thing in question. So `fj` carries the final pose, and the viewer uses it in place of its own work for those parts.

**Not written:**
- part 0: the place and facing, which come from `pos` and the replay.
- quaternion joints.
- the presentation-only parts that the hosted build leaves cold (`JOBJ_MSL_GAMEPLAY_COLD`, from `ftParts_HeadlessGameplayMask`). Those include fingers and faces. They are not animated in the simulator at all, so the viewer keeps its own pose for them.

**Overlap with fp.** `fp` still writes its swinging chains. Where a part appears in both, the values are the same.

**Needs game data:**
- Measure the track size. Expect a few KB per fighter per frame before VTB1/gzip.
- Compare against Dolphin's joint matrices. The joints the user listed (Ganondorf, Marth) should agree to the bit wherever the part is live.
- Decide whether the cold parts are worth animating in the track build. That would mean loading the full tree there instead of `ftParts_HeadlessLoadCompact`, and it needs its own byte-identity check of gameplay.

`fj` is unlocked.

## 0004 Viewer track: the yo-yo's string by the links' out bit

`lm` already writes each link's `x2C_b0` as its out. That was checked against itnessyoyo.c:
- set as the string pays out from the ball (`it_802BF28C`, `it_802BF4A0`), and for the ball itself (`it_802BE65C`, `it_802C0010`)
- cleared as it is drawn back (`it_802BF800`) and under the shortest length (`it_802BF28C`)

So the links that are out form one run from the ball, which is `lm`'s link 0.

The bug was in `hook`. It left a link out only when its place was still at the origin, which is how the hookshot and the grapple mark a link that isn't out yet. A yo-yo link that is not out keeps its spawn place or the hand's (nothing moves it), so the yo-yo's `hook` line drew the string through links the game does not draw. The yo-yo's links are now told by `x2C_b0`, which is what `it_802A24A0` draws by. The hookshot and the grapple are unchanged.

**Needs game data:** `hook` is locked. A visual-state recording with Ness's yo-yo out will change its `hook` digest. Check that only such recordings differ, then re-record them with `python -m tools.validation.visual_state --write`. The viewer itself no longer reads `hook`: it draws chains from `lm`.

## 0005 Viewer track: Fountain of Dreams' water columns stretched to the recorded height

Fountain of Dreams' stage joints got worse with `sp` (stage2 draws from 1,021 to 7,884).

- **Cause.** Each side platform stands on a water column, a copy of part 4 (numbered 4 and 1004 in `sp`). The game stretches the column's root joint (`sp` joint 1) to its platform's height whenever the platform moves (`grIzumi_801CC358`'s `r29` block: scale x `0.5 f + 0.5`, scale y `f`, where `f` is the height over the column's own, clamped to 0.01). When the recording gives the platform's height, the hosted build takes it (`msl_grizumi_apply_replay_platform_height`) and returns before that block. So the column kept its first frame's stretch, `sp` wrote it, and that replaced the viewer's stretch, which follows the height correctly.
- **Fix.** In the track build only, and only with a track on, the replay branch now sets the same stretch from the recorded height, written as the source writes it. The game sets it whenever the platform moves, from the height it moved to, so it always matches the height. Setting it every frame from the recorded height gives the same values.
- **Production.** `.text`, `.rodata` and `.data` of `make native` are byte-identical to the build after 0004. The file still differs, because the inserted lines move later line numbers in `grizumi.c`'s debug info, and the build ID follows them.
- Also checked: the hosted build doesn't create part 2 (the platforms' shadows, `grIzumi_801CBCE8(2)`), so `sp` writes nothing for it and the viewer keeps its own. The column copies are numbered as the viewer names them (the left one 1004, the right one 4).

**Needs game data.** Check stage2 against the game's draws. A visual-state lock that digests the column's joints or the effects at its keys may change on Fountain recordings.

## 0006 Viewer track: sp leaves out joints that stand where a stopped animation left them

0005 did not move Fountain of Dreams (stage2 still 7,884). The pair (stage2:1:1:0, part 1, joint 3) has the game's translation but a 3x3 about 1/940 of the game's. That is a uniform scale, not the column's stretch.

- **Cause.** The hosted build plays a stage part's animation only if the part is in its stage's `runtime_animation_mask` (`configure_headless_ground_schedule`). Fountain's mask has only part 4, the columns. Every other part has its animation removed (`msl_ground_use_headless_epoch_proc`), so its joints stay where the animation was when it stopped. `sp` writes a joint once it leaves the file's rest pose, so it wrote such a joint once, at a scale its animation starts from near zero. That pose then stood over the viewer's own animation for the whole match.
- **Fix.** On a part whose animation the hosted build stopped (its proc is `msl_ground_headless_epoch_proc`), a joint's baseline is the pose it has when `sp` first sees it, not the file's rest. A joint that only the animation moves is never written, so the viewer animates it. A joint the game's code moves is still written when it moves (the platforms on part 3).
- **Other stages.** Yoshi's Story animates parts 2 and 3; Dream Land, Battlefield and the others have their own masks; Stadium animates none. Parts outside the masks change the same way.
- **Left as is.** For a joint written on a stopped part, the viewer reads a value that was never sent as the file's rest value, where its own animation would be closer. That only matters for a joint that code moves and the animation also moves. None is known.
- **Production.** `.text`, `.rodata` and `.data` are identical to the build after 0005.

**Needs game data.** stage2 should come back to about the 1,021 draws it had before `sp`. Yoshi's Story (stage8) should not get worse.

## 0007 Viewer track: fj leaves out the joints of chains the track build does not solve

Peach (f9: 3,362 to 10,959 draws with round 3) and Zelda (f19: 7,781 to 12,064) did not move with the dynamics-counts fix in front.

- **Cause.** The track build does not solve Peach's and Zelda's dress and hair chains, or Donkey Kong's tie. `msl_viewer_track_keep_dynamics` prunes their links as without a track (solved in the simulator they came out further from the game than the viewer's own solve). Their joints stay live, though, at the animation's pose, unsolved. `fj` writes every live part, so it wrote those unsolved joints over the viewer's own solve. That is also why the driven-joint counts changed nothing: those chains are not solved here at all.
- **Fix.** `fj` leaves out every joint of a chain whose links were pruned (its `dyn_desc.data` is `NULL`). The chain is found as `ftCo_8009CF84` links it: `lb_8000FD48` from the chain's bone down its first children, for the chain's count. The viewer keeps its own solve for those joints, as before `fj`. Chains the track build keeps (Fox's tail, Jigglypuff's body, every chain on the other fighters) are still written. The mask is a scratch array allocated once with the track.
- **Production.** `.text`, `.rodata` and `.data` are identical.

**Needs game data.** Peach and Zelda should come back to at least their numbers before `fj`, and the rest of the fighters should not change. Then regenerate the four visual-state locks.

## 0008 Viewer track: Peach's, Zelda's and Donkey Kong's chains solved too

With 0007, Zelda went to 5,559 draws (from 7,781 before `fj`), but Peach is still at 5,378 (from 3,362). What is left wrong is the viewer's own solve of their chains.

- **Change.** `msl_viewer_track_keep_dynamics` pruned these three fighters' chains, because solved in the track build they came out further from the game than the viewer's solve. That was without the dynamics-counts fix, which is now 0001. The exception is removed: their chains are copied and solved like every other fighter's, and `fp` writes them. 0007 skips nothing for them now, because their links are kept.
- **Also suspect, in 0009 next.** The chain joints are presentation-only, so the headless build marks them cold, and a cold joint gets no animation (`HSD_JObjAddAnim` and `JObjAnimAll` return early). A chain solved here therefore starts from the unanimated pose, while in the game the animation drives those joints and the physics works from that. If 0008 alone does not bring Peach and Zelda right, 0009 is the next step.
- **Production.** `.text`, `.rodata` and `.data` are identical.

**Check:** Peach (Jigglypuff vs Peach, Battlefield, fsmash, frame 319: f9:0:32:0, f9:0:50:0), Zelda (Sheik vs Zelda, Dream Land, KO, frame 4480: f19:1:31:0, f19:1:32:0) and Donkey Kong.

## 0009 Viewer track: fj writes the fighter's root turn and size

Ganondorf (KO, frame 3743, f25:0:45:0), Marth (FD, frame 1295, f18:0:39:0) and Game & Watch (FD, frame 1855, f24:2:23:0) are all off on joint 0, which is part 0 (TopN).

- **Cause.** `fj` left part 0 out, as the place and facing that `pos` and the replay give. But the root's rotation also carries what the state's code sets beyond the facing (a tumble's spin, a lean), and its scale is the model's size. The viewer built that rotation from the facing alone.
- **Change.** `fj` writes part 0's rotation and scale (values 0 to 5) and never its translation. The viewer already lays any part `fj` sends onto model joint 0, which is where it builds the root's turn and size itself. A value never sent stays the viewer's, so the root keeps its place from `pos`. No viewer change is needed.
- **Production.** `.text`, `.rodata` and `.data` are identical.

**Check:** Ganondorf f25, Marth f18 and Game & Watch f24. Also check that no fighter's place moves, and that star and screen KOs still draw where they did.

## 0010 Viewer track: world matrices for the pose check (`wf`, `wi`, `ws`), behind `MSL_VIEWER_TRACK_WORLD`

For the pose check (`tools/pose_check.py` in the viewer repo). Off by default. Set `MSL_VIEWER_TRACK_WORLD=1` in the environment of the process that makes the track; the validation runner passes its environment to the simulator it starts. When it is off, nothing is written and nothing is allocated.

```
[frame,"wf",port,sub,character,(part,mask,values)...]  fighter parts, numbered as fj numbers them
[frame,"wi",item,(joint,mask,values)...]                item joints, numbered as jp numbers them, root 0 too
[frame,"ws",part,(joint,mask,values)...]                stage joints, numbered as sp numbers them (0 = the scale root)
```

- **Values.** Twelve values: rows 0 to 2 of the 3 x 4 world matrix, row by row, as float32 bits in hex. Mask bit k means value k follows. A value is written when it changes, and an owner's first line has them all.
- **How each matrix is made.** The simulator computes a joint's matrix only when something reads it, so most joints have no world matrix of their own at a frame's end. This writer therefore makes the matrix `HSD_JObjMakeMatrix` would make from the joint's values at the frame's end: its scale compensation, then `HSD_MtxSRT` / `HSD_MtxSRTQuat` and the concat with the parent (`HSD_MtxSRTConcat` in this build). It makes them in the track's own storage, so no joint, flag or scale vector of the match is touched.
- **Left out, with everything under them:**
  - joints the game places another way: an RObj (constraints and limits), IK joints (`JOBJ_JOINT1`, `JOBJ_JOINT2`, `JOBJ_EFFECTOR`), `JOBJ_USER_DEF_MTX`, `JOBJ_MTX_INDEP_PARENT`, `JOBJ_MTX_INDEP_SRT`, and path animations;
  - fighter parts the hosted build leaves cold (not animated there);
  - every joint of a stage part whose animation the hosted build stops (on Fountain of Dreams, all parts but the water columns).
  
  So the check covers what the simulator does pose; a joint left out here is not checked.
- `wf`, `wi` and `ws` are added to `UNLOCKED_KINDS`.
- **Production.** `.text`, `.rodata` and `.data` are identical.

## 0011 Viewer track: `cns`, a fighter's XRotN hung on its captor's TransN2 (`x2226_b2`)

```
[frame,"cns",port,sub,1|0]
```

- **What it is.** A grab's victim is not hung on the captor's hand from the start. `ftCo_800DB368` puts a position constraint on its XRotN (`lb_8000C1C0` to the captor's TransN2) only once the pull brings it in (ftCo_CatchPull's distance test against `p_ftCommonData` +0x34C/+0x350), and sets `x2226_b2`. The throw's release (`ftCo_800DDDE4`: `lb_8000C390`, XRotN's translation put back) and a broken grab (`ftCo_CaptureCut`) clear it, while the victim can stay in its Thrown state for many frames after.
- **When.** A state line, written at each fighter's first frame (0 or 1) and then on every change, so a track made with this patch always has it: the viewer's old rule (hang every captured or thrown fighter) is kept only for tracks without any `cns` line. (Amended: the first version wrote it only once set, so a game with no capture had no line and the viewer fell back to its old rule, as at bot-fox_falco 2630.)
- **For the viewer.** It hangs the victim's XRotN on the captor's TransN2 only while `cns` is 1. Without the line it keeps its own rule (every captured or thrown frame). This is the pose check's f1 at bot-fox_falco 2630 (CapturePulledLw, frame 1: not hung yet) and f15 at bot-tp_peach_puff 1229 (ThrownHi after the release: let go).
- `cns` is added to `UNLOCKED_KINDS`, so no lock changes.
- **Production.** `.text`, `.rodata` and `.data` are identical.

## 0012 Viewer track: `pos` written once more the frame a fighter is back on the plane

- **What was wrong.** `pos` is written while a fighter is in DeadUp states (4-10) or off the plane (`cur_pos.z != 0`). A state line is written only on change, so a reader can't tell "still at -3.8" from "back at 0": when the condition ended no line came. Nana in bot-ness_ics 3298 is back at z 0 in the game, and the viewer still had the last line's -3.8 (the pose check's f11, -3.8 on every joint).
- **Now.** The frame the condition ends writes the top joint once more (its place then, z 0 for a fighter back on the plane). One line per return.
- **Tracks.** `pos` lines are added; locks with `pos` change (they are regenerated with this series anyway).
- **Production.** `.text`, `.rodata` and `.data` are identical.

## 0013 Viewer track: `bgflash`, a hit's screen flash started (`lbBgFlash_80021C48`)

```
[frame,"bgflash",type,duration]
```

- **What it is.** A strong hit starts lbBgFlash's screen flash: `ftCo_8008DB10` by the hit's element (types 2 to 6) when the knockback passes `p_ftCommonData` +0x178 to +0x188, and `ft_0C8C` (type 0xE). The flash is a full-screen 640 x 480 quad with vertex color under its own camera (`fn_8001FEC4`, `lbl_803BB028`), drawn three times a frame by `HSD_GObj_803910D8`'s mask 7, from the match's first flash on (after it, mode 5 at alpha 0). The game's draws are the gate's `missing|immediate|untextured|invsrcalpha` group (179 draws, 22 windows).
- **Why a patch.** The hosted build stubs `lbBgFlash_80021C48` (src/stubs/headless_exclusions.c), so no track had it. With the visual build the stub writes this event; production keeps the empty stub.
- `bgflash` is added to `UNLOCKED_KINDS`, so no lock changes.
- **Production.** `.text`, `.rodata` and `.data` are identical.
- **Numbering.** Your struct-dump hook goes after this one, as 0014.
