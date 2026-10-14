//! The tracks together (the wave 1b integration): forge-feel's weapons against forge-ai's enemies, the enemies against
//! forge-feel's player, forge-ai's bots through forge-feel's input, and both over forge-core's live co-op, in one
//! core as forge-web installs it (`forge_play::install`). No browser: the same steps a page runs.
use forge_core::cmd::{self, Writer};
use forge_core::components::*;
use forge_core::events::{self, Event};
use forge_core::glam::Vec3;
use forge_core::net::Role;
use forge_core::Core;

const TABLES: &str = r#"{
  "weapons": [ { "id": "sidearm", "preset": "pistol" }, { "id": "scatter", "preset": "shotgun" } ],
  "enemies": [
    { "id": "grunt", "archetype": "chaser", "health": 60 },
    { "id": "soldier", "archetype": "shield" },
    { "id": "brute", "archetype": "brute" }
  ],
  "waves": [ { "id": "one", "enemies": [ { "type": "grunt", "count": 2 } ], "delay": 0.1, "spawnEvery": 0.1 } ]
}"#;

fn core() -> Core {
    let mut c = Core::new();
    assert!(forge_play::install(&mut c), "the feel, the AI and what joins them");
    c.load_tables(TABLES).unwrap();
    let mut w = Writer::default();
    w.add_box([-50.0, -1.0, -50.0], [50.0, 0.0, 50.0]);
    c.cmds[..w.words.len()].copy_from_slice(&w.words);
    c.tick(0.0, w.words.len());
    c
}

fn send(c: &mut Core, w: &Writer, dt: f32) {
    c.cmds[..w.words.len()].copy_from_slice(&w.words);
    c.tick(dt, w.words.len());
}

/// One 60 Hz frame with player `id`'s input (the stick, buttons held and pressed).
fn frame(c: &mut Core, id: u32, mx: f32, mz: f32, held: u32, pressed: u32) {
    let mut w = Writer::default();
    w.input(id, mx, mz, 0.0, 0.0, held, true, pressed);
    send(c, &w, 1.0 / 60.0);
}

fn decoded(c: &Core) -> Vec<(Event, u32)> {
    c.events_out.chunks(events::WORDS).filter_map(|w| Event::decode(w.try_into().unwrap())).collect()
}

fn rule_names(c: &Core, evs: &[(Event, u32)]) -> Vec<String> {
    evs.iter().filter_map(|(e, _)| if let Event::Rule(r) = e { Some(c.sim.names.get(r.name).to_string()) } else { None }).collect()
}

/// An enemy of row `row` standing (no rise) at `at`, facing the player. → its net id.
fn enemy(c: &mut Core, row: u32, at: [f32; 3]) -> u32 {
    let before: Vec<u32> = c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).collect();
    let mut w = Writer::default();
    w.opf(forge_ai::OP_SPAWN, &[row, 1], &[at[0], at[1], at[2], 0.0]);
    send(c, &w, 0.0);
    c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).find(|n| !before.contains(n)).expect("the enemy spawned")
}

#[test]
fn the_plugins_install_once_in_order_and_the_schedule_joins_them() {
    let mut c = Core::new();
    assert!(forge_play::install(&mut c));
    assert_eq!(c.plugins(), ["feel", "ai", "play"]);
    let sys = c.systems();
    let at = |n: &str| sys.iter().position(|s| s.ends_with(n)).unwrap_or_else(|| panic!("{n} in {sys:?}"));
    // an enemy's knock (Ai) reaches the player before the feel's pushes and the character controller (Physics)
    assert!(at("ai.enemies") < at("play.knocks") && at("play.knocks") < at("feel.push") && at("feel.push") < at("core.character"));
    // a flying piece's knock (feel.debris) is queued for the AI after it is made
    assert!(at("feel.debris") < at("play.requests"));
    assert!(!forge_play::install(&mut c), "a second install adds nothing");
}

/// A weapon's shot is the hit forge-ai's enemy reacts to in the same step; the kill is forge-ai's `enemy-down` and
/// forge-feel's debris, coin and `kill`, each once; nothing of the burst is in a snapshot.
#[test]
fn a_shot_hits_an_enemy_that_reacts_and_the_kill_is_both_tracks_once() {
    let mut c = core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let net = enemy(&mut c, 0, [0.0, 0.05, -5.0]);
    let e = c.sim.entity_of(net).unwrap();
    assert!(c.sim.world.get::<&Reacts>(e).is_ok(), "forge-ai plays its own enemies' reactions");
    // a few frames standing, then the trigger: a pistol round takes about 60 ms over 5 m
    for _ in 0..6 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
    }
    let (mut hits, mut flashes, mut kills, mut downs, mut kill_rules, mut die_sounds, mut frames) = (0, 0, 0, 0, 0, 0, 0);
    let bone_break = c.sim.names.id("bone-break");
    let mut reacted = false;
    while kills == 0 && frames < 400 {
        // one press every 24 frames (the pistol's interval is under that; it reloads by itself when empty)
        frame(&mut c, 1, 0.0, 0.0, 0, if frames % 24 == 0 { cmd::BTN_FIRE } else { 0 });
        frames += 1;
        let evs = decoded(&c);
        for (ev, _) in &evs {
            match ev {
                Event::Hit(h) if h.target == net => {
                    hits += 1;
                    assert_eq!(h.attacker, 1);
                }
                Event::Kill(k) if k.target == net => kills += 1,
                Event::Custom { kind, words } if *kind == forge_feel::ev::FLASH && words[0] == net => flashes += 1,
                Event::Sound(s) if s.name == bone_break && s.source == net => die_sounds += 1,
                _ => {}
            }
        }
        let rules = rule_names(&c, &evs);
        downs += rules.iter().filter(|r| *r == "enemy-down").count();
        kill_rules += rules.iter().filter(|r| *r == "kill").count();
        if let Some(e) = c.sim.entity_of(net)
            && let Ok(en) = c.sim.world.get::<&forge_ai::Enemy>(e)
        {
            reacted |= en.flash > 0.0 || en.eye_white > 0.0;
        }
    }
    assert!(hits >= 2, "60 hit points take more than one pistol round ({hits} hits in {frames} frames)");
    assert_eq!(flashes, hits, "every hit flashes the body (forge-feel's FLASH, which the renderer draws)");
    assert!(reacted, "forge-ai's enemy reacted to the weapon's hit (its flash and white eyes)");
    assert_eq!((kills, downs, kill_rules), (1, 1, 1), "one kill: forge-ai's enemy-down and forge-feel's kill, each once");
    assert_eq!(die_sounds, 1, "the enemy's own death sound once, not once a track");
    assert!(c.sim.entity_of(net).is_none(), "the body went on the kill's step");
    let pieces = c.sim.world.query::<(&Kind, &Local)>().iter().filter(|(k, _)| k.kind == kind::DEBRIS).count();
    assert!((30..=60).contains(&pieces), "it burst into pieces ({pieces})");
    let coins = c.sim.world.query::<(&Kind, &Local)>().iter().filter(|(k, _)| k.kind == forge_feel::kinds::COIN).count();
    assert_eq!(coins, 1);
    // none of it rides a snapshot: every copy bursts its own
    let snap = forge_core::snapshot::decode(&c.snapshot()).unwrap();
    assert!(snap.actors.is_empty(), "{} actors in the snapshot after the burst", snap.actors.len());
    assert!(snap.events.iter().all(|(e, _)| !matches!(e, Event::Despawn(d) if d.id >= forge_core::sim::LOCAL_NET_ID)));
}

/// An enemy's attack is the damage forge-feel's hurt path reads: the red tint, the thud, and at zero the death's rule.
#[test]
fn an_enemys_lunge_hurts_the_player_through_the_feels_hurt_path() {
    let mut c = core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let net = enemy(&mut c, 0, [0.0, 0.05, -3.0]);
    let hurt = c.sim.names.id("hurt");
    let (mut tint, mut thuds, mut dead_rule, mut hit_by) = (0.0f32, 0, 0, 0);
    for _ in 0..(60 * 25) {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
        let evs = decoded(&c);
        for (ev, _) in &evs {
            match ev {
                Event::Hit(h) if h.target == 1 => hit_by = h.attacker,
                Event::Sound(s) if s.name == hurt && s.source == 1 => thuds += 1,
                _ => {}
            }
        }
        dead_rule += rule_names(&c, &evs).iter().filter(|r| *r == "player-dead").count();
        let v = c.sim.res.get::<forge_feel::view::FeelView>().unwrap();
        tint = tint.max(v.v[forge_feel::view::field::TINT]);
        if dead_rule > 0 {
            break;
        }
    }
    assert_eq!(hit_by, net, "the chaser's lunge landed");
    assert!(tint >= 0.59, "each hit adds 0.6 of red edge (the most seen: {tint})");
    assert!(thuds >= 1, "the hurt thud on the hit's step");
    assert_eq!(dead_rule, 1, "left alone, the player dies and the rules hear it once");
    let v = c.sim.res.get::<forge_feel::view::FeelView>().unwrap();
    assert_eq!(v.v[forge_feel::view::field::DEAD], 1.0);
}

/// forge-ai's knock on a player (a brute's slam) is forge-feel's knock-down: no control for its time, pushed away,
/// never longer than fair play allows.
#[test]
fn a_brutes_slam_knocks_the_player_down_through_the_feels_controller() {
    let mut c = core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    enemy(&mut c, 2, [0.0, 0.05, -2.2]);
    let p = c.player(1).unwrap();
    let (mut knocked_at, mut secs, mut longest, mut run) = (None, 0.0f32, 0usize, 0usize);
    let (mut at_knock, mut far_z) = (Vec3::ZERO, f32::MIN);
    for f in 0..(60 * 12) {
        // the player holds forward the whole time: while down, the stick does nothing
        frame(&mut c, 1, 0.0, 1.0, 0, 0);
        for (ev, _) in decoded(&c) {
            if let Event::Custom { kind, words } = ev
                && kind == forge_ai::EV_KNOCK
                && knocked_at.is_none()
            {
                assert_eq!(words[0], 1);
                secs = f32::from_bits(words[5]);
                knocked_at = Some(f);
                at_knock = c.sim.world.get::<&Transform>(p).unwrap().pos;
            }
        }
        let down = c.sim.world.get::<&forge_feel::controller::Pilot>(p).map(|x| x.down).unwrap_or(0.0);
        if down > 0.0 {
            run += 1;
            longest = longest.max(run);
            far_z = far_z.max(c.sim.world.get::<&Transform>(p).unwrap().pos.z);
            assert_eq!(c.sim.res.get::<forge_feel::view::FeelView>().unwrap().v[forge_feel::view::field::DOWN] > 0.0, true);
        } else {
            run = 0;
        }
        if knocked_at.is_some_and(|k| f > k + 90) {
            break;
        }
        if c.sim.world.get::<&Health>(p).unwrap().dead {
            break;
        }
    }
    let k = knocked_at.expect("the brute's slam knocked the player down");
    assert!(secs > 0.0 && secs <= 0.8, "forge-ai's fair-play bound ({secs} s)");
    assert!(longest >= 2 && longest as f32 / 60.0 <= secs + 0.05, "down for the knock's time and no longer ({longest} frames for {secs} s)");
    assert!(far_z > at_knock.z + 0.5, "pushed back from the brute while down, against the held stick ({} → {far_z}, knocked at frame {k})", at_knock.z);
}

/// forge-feel's knock on an enemy (a flying piece) is forge-ai's knock-down at its next step.
#[test]
fn a_flying_pieces_knock_lays_the_enemy_down() {
    let mut c = core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let net = enemy(&mut c, 0, [0.0, 0.05, -8.0]);
    for _ in 0..10 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
    }
    let e = c.sim.entity_of(net).unwrap();
    assert_ne!(c.sim.world.get::<&forge_ai::Enemy>(e).unwrap().state, forge_ai::State::Down);
    // forge-feel's event as `feel.debris` emits it, from a system in the same stage before `play.requests`
    let mut once = true;
    assert!(c.schedule.add_before("play.requests", "test.knock", move |sim| {
        if std::mem::take(&mut once) {
            forge_feel::custom(sim, forge_feel::ev::KNOCK, &[forge_feel::W::U(net), forge_feel::W::F(0.9), forge_feel::W::F(0.0), forge_feel::W::F(0.0), forge_feel::W::F(-1.0), forge_feel::W::U(1)]);
        }
    }));
    frame(&mut c, 1, 0.0, 0.0, 0, 0);
    frame(&mut c, 1, 0.0, 0.0, 0, 0);
    assert_eq!(c.sim.world.get::<&forge_ai::Enemy>(e).unwrap().state, forge_ai::State::Down, "forge-ai laid it down");
    for _ in 0..40 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
    }
    assert_eq!(c.sim.world.get::<&forge_ai::Enemy>(e).unwrap().state, forge_ai::State::Down, "for the knock's 0.9 s");
    for _ in 0..90 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
    }
    assert_ne!(c.sim.world.get::<&forge_ai::Enemy>(e).unwrap().state, forge_ai::State::Down, "then it gets up");
}

/// A weapon's damage on a shield is the share forge-ai's shield region lets through.
#[test]
fn a_shield_blocks_the_share_forge_ai_says() {
    let mut c = core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let net = enemy(&mut c, 1, [0.0, 0.05, -4.0]);
    let (mut front, mut frames) = (None, 0);
    while front.is_none() && frames < 240 {
        frame(&mut c, 1, 0.0, 0.0, 0, if frames % 24 == 6 { cmd::BTN_FIRE } else { 0 });
        frames += 1;
        for (ev, _) in decoded(&c) {
            if let Event::Hit(h) = ev
                && h.target == net
            {
                front = Some(h.damage);
            }
        }
    }
    let dmg = front.expect("a round reached the soldier");
    let pistol = forge_feel::cfg(&c.sim).weapons[0].damage;
    assert!(dmg < pistol * 0.5, "the shield took most of a {pistol} damage round ({dmg} got through)");
}

/// forge-ai's bot is a player whose Control it writes: forge-feel's weapons fire for it and its rounds hit.
#[test]
fn a_bot_fights_through_the_feels_weapons() {
    let mut c = core();
    c.sim.spawn_player(1, Vec3::new(8.0, 0.05, 8.0), 0.0, true, true);
    c.sim.spawn_player(2, Vec3::new(0.0, 0.05, 0.0), 0.0, false, true);
    let net = enemy(&mut c, 0, [0.0, 0.05, -9.0]);
    let (mut bot_hits, mut shots) = (0, 0u32);
    for _ in 0..(60 * 10) {
        // OP_BOT every frame, as gf/forge/ai.js sends it: player 2, enabled, mode auto (0), no aim given
        let mut w = Writer::default();
        w.input(1, 0.0, 0.0, 0.0, 0.0, 0, true, 0);
        w.opf(forge_ai::OP_BOT, &[2, 1, 0, 0, 0, 0], &[0.9, 0.0, 0.0, 0.0, 0.8, 0.0, 0.0, 0.0]);
        send(&mut c, &w, 1.0 / 60.0);
        for (ev, _) in decoded(&c) {
            if let Event::Hit(h) = ev
                && h.target == net
                && h.attacker == 2
            {
                bot_hits += 1;
            }
        }
        shots = c.sim.world.get::<&forge_feel::weapons::Arms>(c.player(2).unwrap()).map(|a| a.shots).unwrap_or(0);
        if c.sim.entity_of(net).is_none() {
            break;
        }
    }
    assert!(shots > 0, "the bot's fire presses fired forge-feel's weapon");
    assert!(bot_hits > 0, "and its rounds hit the enemy ({shots} shots)");
    // what friends see in its hand is the weapon forge-feel drew
    let held = c.sim.world.get::<&Wear>(c.player(2).unwrap()).unwrap().held;
    assert_eq!(held, 0, "Wear::held follows the feel's weapon in hand");
}

/// Live co-op with weapons and enemies: the joiner's shot is its own at once (recoil, the muzzle light, the round),
/// the host replays it and deals the damage, and the host's hit and kill come back to the joiner's feel (its damage
/// number, its own pieces), none of them twice.
#[test]
fn a_joiner_fires_at_the_hosts_enemy_predicts_the_shot_and_gets_the_hosts_hit_and_kill() {
    let (mut host, mut joiner) = (core(), core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    host.sim.spawn_player(1, Vec3::new(6.0, 0.05, 6.0), 0.0, true, true);
    host.sim.spawn_player(2, Vec3::new(0.0, 0.05, 0.0), 0.0, false, true);
    joiner.sim.spawn_player(2, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    // 30 hit points: two pistol rounds
    let mut w = Writer::default();
    w.opf(forge_ai::OP_SPAWN, &[0, 1], &[0.0, 0.05, -5.0, 0.0]);
    send(&mut host, &w, 0.0);
    let net = host.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).next().unwrap();
    host.sim.world.get::<&mut Health>(host.sim.entity_of(net).unwrap()).unwrap().hp = 30.0;
    joiner.apply(&host.snapshot()).unwrap();
    assert!(joiner.sim.entity_of(net).is_some_and(|e| joiner.sim.world.get::<&Replica>(e).is_ok()), "the host's enemy is a replica on the joiner");

    let (mut own_light_at, mut numbers, mut remote_hits, mut remote_kills, mut local_hits) = (None, 0, 0, 0, 0);
    let (mut joiner_lights, mut shot_sounds) = (0, 0);
    let shot = joiner.sim.names.id("weapon-pistol-shot");
    let mut recoil = 0.0f32;
    for f in 0..240 {
        let press = if f % 24 == 4 { cmd::BTN_FIRE } else { 0 };
        let mut w = Writer::default();
        w.input(2, 0.0, 0.0, 0.0, 0.0, 0, true, press);
        send(&mut joiner, &w, 1.0 / 60.0);
        if f % 3 == 0 {
            let batch = joiner.net_take_inputs();
            host.net_push_inputs(2, &batch).unwrap();
        }
        frame(&mut host, 1, 0.0, 0.0, 0, 0);
        for (ev, flags) in decoded(&joiner) {
            let remote = flags & events::FLAG_REMOTE != 0;
            match ev {
                Event::Light(l) if l.source == 2 => {
                    joiner_lights += 1;
                    assert!(!remote, "the host's copy of the joiner's own muzzle light is not drawn twice");
                    if press != 0 {
                        own_light_at.get_or_insert(f);
                    }
                }
                Event::Sound(s) if s.name == shot && s.source == 2 => {
                    shot_sounds += 1;
                    assert!(!remote);
                }
                Event::Hit(h) if h.target == net => {
                    if remote { remote_hits += 1 } else { local_hits += 1 }
                }
                Event::Kill(k) if k.target == net && remote => remote_kills += 1,
                Event::Ui(u) if u.what == events::UI_DAMAGE && u.player == 2 => numbers += 1,
                _ => {}
            }
        }
        recoil = recoil.max(joiner.sim.world.get::<&forge_feel::weapons::Arms>(joiner.player(2).unwrap()).map(|a| a.recoil.x).unwrap_or(0.0));
        if f % 6 == 5 {
            joiner.apply(&host.snapshot()).unwrap();
        }
        if remote_kills > 0 && f % 6 == 4 {
            break;
        }
    }
    assert_eq!(own_light_at, Some(4), "the joiner's muzzle light on the frame of its press (prediction)");
    assert!(recoil > 0.005, "and its recoil ({recoil} rad)");
    assert_eq!(local_hits, 0, "a replica is the host's to hurt");
    assert!(remote_hits >= 2 && remote_kills == 1, "the host replayed the shots: {remote_hits} hits and {remote_kills} kill came back");
    assert_eq!(numbers, remote_hits, "each of the host's hits shows the joiner its damage number");
    assert!(shot_sounds >= 2 && joiner_lights >= 2);
    // the joiner's own pieces from the host's kill, and its picture of the coin; the host's are the host's
    let pieces = |c: &Core| c.sim.world.query::<(&Kind, &Local)>().iter().filter(|(k, _)| k.kind == kind::DEBRIS).count();
    assert!(pieces(&joiner) >= 30, "the joiner burst its own pieces ({})", pieces(&joiner));
    assert!(pieces(&host) >= 30);
    assert!(joiner.sim.entity_of(net).is_none(), "the replica left with the host's body");
    let snap = forge_core::snapshot::decode(&host.snapshot()).unwrap();
    assert!(snap.actors.iter().all(|a| a.kind != kind::DEBRIS && a.kind != forge_feel::kinds::COIN), "no debris or coin in a snapshot");
    // the joiner's kill counts in its own feel (the combo), and the score is the host's rule event
    let v = joiner.sim.res.get::<forge_feel::view::FeelView>().unwrap();
    assert_eq!(v.v[forge_feel::view::field::KILLS], 1.0);
    // friends see what the joiner holds: the host's copy of its Wear
    assert_eq!(host.sim.world.get::<&Wear>(host.player(2).unwrap()).unwrap().held, 0);
}

/// Wave 4 (watch then play): a viewer's copy beside a host and a joiner, looking through the joiner's eyes. It has no
/// player of its own; the watched player's shots reach its first-person weapon (the kick and the recoil from the byte
/// the host's snapshot carries for a player, the muzzle light and the sound as the host's events, none left out), the
/// host's hits show their numbers, the kill bursts the viewer's own pieces, and a reload and a quick melee play.
#[test]
fn a_viewer_sees_the_watched_players_fight_through_their_eyes() {
    use forge_feel::view::field as fv;
    let (mut host, mut joiner, mut viewer) = (core(), core(), core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    viewer.net_role(Role::Viewer, 0, 0);
    viewer.net_watch(2);
    host.sim.spawn_player(1, Vec3::new(6.0, 0.05, 6.0), 0.0, true, true);
    host.sim.spawn_player(2, Vec3::new(0.0, 0.05, 0.0), 0.0, false, true);
    joiner.sim.spawn_player(2, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let mut w = Writer::default();
    w.opf(forge_ai::OP_SPAWN, &[0, 1], &[0.0, 0.05, -5.0, 0.0]);
    send(&mut host, &w, 0.0);
    let net = host.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).next().unwrap();
    host.sim.world.get::<&mut Health>(host.sim.entity_of(net).unwrap()).unwrap().hp = 30.0;
    let s0 = host.snapshot();
    joiner.apply(&s0).unwrap();
    viewer.apply(&s0).unwrap();
    let shot = viewer.sim.names.id("weapon-pistol-shot");
    let (mut lights, mut shots, mut numbers, mut hits, mut kills, mut local) = (0, 0, 0, 0, 0, 0);
    let (mut kick, mut recoil, mut reloading, mut quick) = (0.0f32, 0.0f32, false, false);
    let mut killed_at = None;
    for f in 0..420 {
        // two rounds into the enemy, then a reload by hand, then the quick melee
        let press = if killed_at.is_none() && f % 24 == 4 { cmd::BTN_FIRE } else if killed_at.is_some_and(|k| f == k + 20) { cmd::BTN_RELOAD } else if killed_at.is_some_and(|k| f == k + 140) { cmd::BTN_MELEE } else { 0 };
        let mut w = Writer::default();
        w.input(2, 0.0, 0.0, 0.0, 0.0, 0, true, press);
        send(&mut joiner, &w, 1.0 / 60.0);
        if f % 3 == 0 {
            let batch = joiner.net_take_inputs();
            host.net_push_inputs(2, &batch).unwrap();
        }
        frame(&mut host, 1, 0.0, 0.0, 0, 0);
        viewer.tick(1.0 / 60.0, 0);
        for (ev, flags) in decoded(&viewer) {
            let remote = flags & events::FLAG_REMOTE != 0;
            match ev {
                Event::Light(l) if l.source == 2 => { lights += 1; local += !remote as u32; }
                Event::Sound(s) if s.name == shot && s.source == 2 => { shots += 1; local += !remote as u32; }
                Event::Hit(h) if h.target == net => { hits += 1; local += !remote as u32; }
                Event::Kill(k) if k.target == net => { kills += 1; killed_at.get_or_insert(f); }
                Event::Ui(u) if u.what == events::UI_DAMAGE && u.player == 2 => numbers += 1,
                _ => {}
            }
        }
        if let Ok(a) = viewer.sim.world.get::<&forge_feel::weapons::Arms>(viewer.player(2).unwrap()) {
            kick = kick.max(a.view_kick);
            recoil = recoil.max(a.recoil.x);
            quick |= a.swing.is_some_and(|s| s.quick);
        }
        let v = viewer.sim.res.get::<forge_feel::view::FeelView>().unwrap().v;
        reloading |= v[fv::RELOADING] > 0.5;
        if f > 12 {
            assert_eq!((v[fv::PLAYER], v[fv::WEAPON], v[fv::MAGAZINE]), (2.0, 0.0, 0.0), "the view is the watched player's: its weapon in hand, its rounds unknown");
        }
        if f % 6 == 5 {
            let s = host.snapshot();
            joiner.apply(&s).unwrap();
            viewer.apply(&s).unwrap();
        }
    }
    let who: Vec<(u32, bool, bool)> = viewer.sim.world.query::<&Player>().iter().map(|p| (p.id, p.local, p.owned)).collect();
    assert!(who.len() == 2 && who.iter().all(|p| !p.2) && who.iter().filter(|p| p.1).map(|p| p.0).eq([2]), "no player of its own; the watched one is local ({who:?})");
    assert_eq!(local, 0, "a viewer predicts nothing: every light, sound and hit is the host's");
    assert!(lights >= 2 && shots >= 2, "the watched player's muzzle lights and shots are played, not left out ({lights} lights, {shots} shots)");
    assert!(hits >= 2 && kills == 1 && numbers == hits, "the host's {hits} hits show their numbers ({numbers}) and its kill arrives ({kills})");
    assert!(kick > 0.002 && recoil > 0.005, "a shot snaps the weapon in the viewer's view and kicks its camera (kick {kick}, recoil {recoil} rad)");
    assert!(reloading && quick, "the reload's dip and the quick melee's swing play (reload {reloading}, swing {quick})");
    let pieces = viewer.sim.world.query::<(&Kind, &Local)>().iter().filter(|(k, _)| k.kind == kind::DEBRIS).count();
    assert!(pieces >= 30, "the viewer burst its own pieces ({pieces})");
    // the camera is the watched player's eyes, and nothing was reconciled or sent
    assert_eq!(viewer.views.camera[forge_core::views::camera::PLAYER], 2.0);
    let n = viewer.net().unwrap();
    assert_eq!((n.stats.checked, n.stats.inputs_sent, n.stats.suppressed), (0, 0, 0));
    assert_eq!(v_kills(&viewer), 1.0, "the watched player's kill counts in the view");
}

/// Wave 4: what a stream carries of a forge game is the host's world message, and the relay drops a teed message over
/// 8,000 characters (gf-multiplayer party.js `liveTee`; the room itself one over 4,096 bytes). The message is the
/// core's snapshot in base64 with the round's own state round it (kit/net/session.js). Bone Vigil's own tables, four
/// players, its largest wave (the third: as four players meet it, 22 alive at once), everyone firing for 20 s: the
/// largest snapshot of the fight, and the message it makes, with room to spare (tools/stream.test.mjs holds the same
/// against the kit's own numbers for a snapshot at its limit).
#[test]
fn bone_vigils_largest_wave_with_four_players_fits_the_room_and_the_streams_relay() {
    use forge_core::serde_json::Value;
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../specs/vigil.spec.json")).expect("research/gf-forge/specs/vigil.spec.json");
    let spec: Value = forge_core::serde_json::from_str(&text).unwrap();
    let mut host = core();
    host.load_tables(&spec["forge"].to_string()).unwrap();
    host.net_role(Role::Host, 1, 0);
    for id in 1..=4u32 {
        let e = host.sim.spawn_player(id, Vec3::new(id as f32 * 1.5 - 3.75, 0.05, 0.0), 0.0, id == 1, true);
        // nobody falls: the wave stays full for the whole fight
        let _ = host.sim.world.insert_one(e, Health::new(1.0e6));
    }
    op(&mut host, forge_ai::OP_DIRECTOR, &[3, 2], &[]);
    let (mut largest, mut alive_most, mut snaps, mut cut) = (0usize, 0usize, 0u32, 0u32);
    let mut sizes: Vec<usize> = Vec::new();
    for f in 0..1200u32 {
        // every player fires (a press every fifth of a second) and turns a little, so shots land all round
        let mut w = Writer::default();
        for id in 1..=4u32 {
            let press = if (f + id * 3) % 12 == 0 { cmd::BTN_FIRE } else { 0 };
            w.input(id, 0.0, 0.0, 0.02, 0.0, 0, true, press);
        }
        send(&mut host, &w, 1.0 / 60.0);
        alive_most = alive_most.max(host.sim.world.query::<(&forge_ai::Enemy, &Health)>().iter().filter(|(_, h)| !h.dead).count());
        // a snapshot twelve times a second, as the round's world message takes them
        if f % 5 == 4 {
            let s = host.snapshot();
            let d = forge_core::snapshot::decode(&s).unwrap();
            assert_eq!(d.players.len(), 4);
            cut += (d.flags & forge_core::snapshot::FLAG_ACTORS_CUT != 0) as u32;
            largest = largest.max(s.len());
            sizes.push(s.len());
            snaps += 1;
        }
    }
    sizes.sort();
    let median = sizes[sizes.len() / 2];
    // base64, then the JSON round it: {"k":{…four players' scores and who stands…},"s":{…},"f":"…"} (300 characters is
    // twice what the round's own state takes with four players), then the tee's own [ms, "w", from, …]
    let message = largest.div_ceil(3) * 4 + 300;
    let teed = message + 24;
    eprintln!("bone vigil, four players, the third wave: {snaps} snapshots, median {median} bytes, largest {largest} bytes ({alive_most} alive at most, {cut} with actors left for the next); the largest world message about {message} characters, teed {teed}");
    // nearly full: 22 can stand at once, and the four players' rounds fell some as they rise (19 at most since a
    // chaser stands level with the eyes and rounds fired with no up or down aim land on it; 21 before)
    assert!(alive_most >= 18, "the wave was nearly full ({alive_most} alive at most)");
    assert_eq!(cut, 0, "every enemy of a full wave fits each snapshot");
    assert!(largest <= forge_core::snapshot::MAX_BYTES);
    assert!(message <= 4096, "the room carries it ({message} characters of 4,096)");
    assert!(teed <= 8000, "and the stream's relay ({teed} characters of 8,000)");
}

fn v_kills(c: &Core) -> f32 {
    c.sim.res.get::<forge_feel::view::FeelView>().unwrap().v[forge_feel::view::field::KILLS]
}

/// On a joiner an enemy is a replica with no brain: `play.replicas` plays its row's clip for the state the host's
/// snapshot carries (standing, the chase, the tell, the attack), where it would otherwise slide in its last pose. On the real grim
/// lord and the forge clip file (anim-fixture.mjs writes them, decoded, to ~/.cache/gf-forge/anim-fixture/forge;
/// without them this test says so and passes).
#[test]
fn a_joiners_replica_enemy_plays_its_rows_clips_for_the_hosts_state() {
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".cache/gf-forge/anim-fixture/forge");
    let (Ok(clips), Ok(body)) = (std::fs::read(dir.join("forge-clips.glb")), std::fs::read(dir.join("skeleton-grim-lord.glb"))) else {
        eprintln!("replica clips: no fixture at {} (node research/gf-forge/tools/anim-fixture.mjs); skipped", dir.display());
        return;
    };
    let (mut host, mut joiner) = (core(), core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    host.sim.spawn_player(1, Vec3::new(0.0, 0.05, 6.0), 0.0, true, true);
    host.sim.spawn_player(2, Vec3::new(2.0, 0.05, 6.0), 0.0, false, true);
    joiner.sim.spawn_player(2, Vec3::new(2.0, 0.05, 6.0), 0.0, true, true);
    // each copy loads the same body and clips (the kit does: ai.js)
    let mut ids = Vec::new();
    for c in [&mut host, &mut joiner] {
        ids.push((c.sim.anim.library.add_clips(&clips).unwrap(), c.sim.anim.library.add_body(&body).unwrap()));
    }
    let net = enemy(&mut host, 0, [0.0, 0.05, -4.0]);
    let he = host.sim.entity_of(net).unwrap();
    host.sim.animate(he, ids[0].1, ids[0].0, None).unwrap();
    joiner.apply(&host.snapshot()).unwrap();
    let je = joiner.sim.entity_of(net).expect("the host's enemy on the joiner");
    assert!(joiner.sim.world.get::<&Replica>(je).is_ok() && joiner.sim.world.get::<&forge_ai::Enemy>(je).is_err(), "a replica, with no brain");
    joiner.sim.animate(je, ids[1].1, ids[1].0, None).unwrap();
    let def = host.sim.res.get::<forge_ai::Roster>().unwrap().def(0).into_owned();
    let clip_of = |c: &Core, name: &str| c.sim.anim.library.sets[ids[1].0].clip(name);
    let chase = clip_of(&joiner, &def.clips.move_);
    assert!(chase.is_some(), "the row's move clip is in the clip file ({})", def.clips.move_);
    let k = &def.clips;
    let row_clips: Vec<usize> = [&k.arrive, &k.idle, &k.move_, &k.tell, &k.attack, &k.recover, &k.hit[0], &k.fall, &k.rise, &k.roar, &k.die].iter().filter_map(|n| clip_of(&joiner, n)).collect();
    let playing = |c: &Core, e| c.sim.world.get::<&forge_core::sim::Animated>(e).ok().and_then(|a| a.animator.base.as_ref().map(|p| p.clip));
    let mut seen: Vec<usize> = Vec::new();
    let mut agreed = 0;
    for f in 0..300 {
        frame(&mut host, 1, 0.0, 0.0, 0, 0);
        frame(&mut joiner, 2, 0.0, 0.0, 0, 0);
        if f % 6 == 5 {
            joiner.apply(&host.snapshot()).unwrap();
        }
        if let Some(c) = playing(&joiner, je) {
            if seen.last() != Some(&c) {
                seen.push(c);
            }
            // (the host's enemy, animated by its brain, plays the same clip a few frames earlier)
            if playing(&host, he) == Some(c) {
                agreed += 1;
            }
        }
    }
    assert!(!seen.is_empty() && seen.iter().all(|c| row_clips.contains(c)), "it plays only its row's clips (played: {seen:?}; the row's: {row_clips:?})");
    assert!(seen.contains(&chase.unwrap()) && seen.len() >= 2, "it walks with the row's move clip and changes clip as the host's state does (played: {seen:?})");
    assert!(agreed > 200, "the joiner's replica plays what the host's enemy plays most of the time ({agreed} of 300 frames)");
}

// ---- wave 2, the game loop: cards, the reward, down and revive, and co-op under a hit ----

const RUN_TABLES: &str = r#"{
  "weapons": [ { "id": "sidearm", "preset": "pistol" }, { "id": "scatter", "preset": "shotgun", "start": false } ],
  "enemies": [ { "id": "grunt", "archetype": "chaser", "health": 60 }, { "id": "brute", "archetype": "brute" } ],
  "waves": [ { "id": "one", "enemies": [ { "type": "grunt", "count": 2 } ], "delay": 0.1, "spawnEvery": 0.1, "reward": true }, { "id": "two", "enemies": [ { "type": "grunt", "count": 1 } ] } ],
  "cards": [
    { "id": "fleet", "stat": "player.walk", "mul": 1.2 },
    { "id": "quick", "stat": "weapons.*.reload", "mul": 0.7 },
    { "id": "drum", "stat": "weapons.sidearm.magazine", "add": 3, "rarity": "rare" },
    { "id": "keen", "stat": "weapons.*.critMultiplier", "add": 0.5, "rarity": "rare" },
    { "id": "gun", "kind": "weapon", "weapon": "scatter", "rarity": "epic" },
    { "id": "draught", "kind": "heal", "share": 0.5 },
    { "id": "light", "stat": "player.stamina.evadeCost", "mul": 0.6 }
  ]
}"#;

fn run_core() -> Core {
    let mut c = core();
    c.load_tables(RUN_TABLES).unwrap();
    c
}

/// A host (player 1, standing at `h`) and a joiner (player 2, at `j`), as the kit spawns them.
fn pair(h: Vec3, j: Vec3) -> (Core, Core) {
    let (mut host, mut joiner) = (run_core(), run_core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    host.sim.spawn_player(1, h, 0.0, true, true);
    host.sim.spawn_player(2, j, 0.0, false, true);
    joiner.sim.spawn_player(2, j, 0.0, true, true);
    (host, joiner)
}

/// One 60 Hz frame of both copies as the page runs them: the joiner's input and step, its batch to the host every third
/// frame, the host's input and step, the host's snapshot to the joiner every sixth (unless `hold` keeps it back).
fn both(host: &mut Core, joiner: &mut Core, f: usize, j: (f32, f32, u32, u32), h: (f32, f32, u32, u32), hold: bool) {
    frame(joiner, 2, j.0, j.1, j.2, j.3);
    if f % 3 == 0 {
        let batch = joiner.net_take_inputs();
        host.net_push_inputs(2, &batch).unwrap();
    }
    frame(host, 1, h.0, h.1, h.2, h.3);
    if f % 6 == 5 && !hold {
        joiner.apply(&host.snapshot()).unwrap();
    }
}

fn op(c: &mut Core, op: u32, ints: &[u32], floats: &[f32]) {
    let mut w = Writer::default();
    w.opf(op, ints, floats);
    send(c, &w, 0.0);
}

fn pos(c: &Core, id: u32) -> Vec3 {
    c.sim.world.get::<&Transform>(c.player(id).unwrap()).unwrap().pos
}

fn cards_of(c: &Core, id: u32) -> Vec<u8> {
    c.sim.world.get::<&forge_feel::cards::Build>(c.player(id).unwrap()).map(|b| b.cards.clone()).unwrap_or_default()
}

/// A card's faster walk is the same walk on the host and in the joiner's prediction: the snapshot carries the card, so
/// the joiner is not corrected every step. A card taken mid-run costs one small correction (the steps the joiner
/// walked before it heard).
#[test]
fn a_card_makes_its_player_faster_on_both_copies_and_the_joiner_predicts_with_it() {
    let (mut host, mut joiner) = pair(Vec3::new(8.0, 0.05, 8.0), Vec3::new(0.0, 0.05, 20.0));
    // the host gives the joiner's player the walk card (as a pick does); the next snapshot tells the joiner
    op(&mut host, forge_feel::op::CARD, &[2, 0], &[]);
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    assert_eq!((cards_of(&host, 2), cards_of(&joiner, 2)), (vec![0], vec![0]), "the card is on both copies' player 2");
    assert!(cards_of(&host, 1).is_empty(), "and only on the player who took it");
    let (mut from, mut speed) = (Vec3::ZERO, 0.0);
    for f in 12..192 {
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
        if f == 131 {
            from = pos(&joiner, 2);
        }
        if f == 191 {
            speed = pos(&joiner, 2).distance(from);
        }
    }
    assert!((speed - 9.36).abs() < 0.05, "7.8 × 1.2 on the joiner's own screen ({speed} m in a second)");
    let n = joiner.net().unwrap().stats;
    eprintln!("co-op stats: {n:?}");
    assert!(n.checked > 20 && n.max_error < 0.05, "the host replays the same faster walk: nothing to correct ({n:?})");
    // host's own player keeps the table's walk
    assert!((forge_feel::cards::of(&host.sim, host.player(1).unwrap()).player.walk - 7.8).abs() < 1e-6);
    // a second copy taken while running: one correction of the few steps before the joiner heard, then none
    op(&mut host, forge_feel::op::CARD, &[2, 0], &[]);
    for f in 192..300 {
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let n2 = joiner.net().unwrap().stats;
    assert_eq!(cards_of(&joiner, 2), vec![0, 0]);
    assert!(n2.max_error < 0.45 && n2.corrected - n.corrected <= 3 && n2.last_error < 0.05, "a card mid-run: at most a step or two corrected ({n2:?})");
    assert!((forge_feel::cards::of(&joiner.sim, joiner.player(2).unwrap()).player.walk - 11.232).abs() < 1e-3);
}

/// The deal is the same on two copies from one seed, different for each player, and what the host dealt and what each
/// player chose reach a joiner with the snapshot; the pick is the host's to apply.
#[test]
fn a_reward_is_dealt_the_same_on_two_copies_and_a_pick_survives_the_snapshot() {
    let offers = |c: &Core, id: u32| c.sim.res.get::<forge_feel::cards::Reward>().and_then(|r| r.choices.get(&id).copied());
    // two copies that each own the world (two hosts, or the same run again): one seed, one deal
    let (mut a, mut b) = (run_core(), run_core());
    for c in [&mut a, &mut b] {
        c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
        c.sim.spawn_player(2, Vec3::new(2.0, 0.05, 0.0), 0.0, false, true);
        op(c, forge_feel::op::REWARD, &[1, 3, 99, 0], &[20.0]);
    }
    let (a1, a2) = (offers(&a, 1).unwrap(), offers(&a, 2).unwrap());
    assert_eq!((a1, a2), (offers(&b, 1).unwrap(), offers(&b, 2).unwrap()), "one seed: the same three cards for each player on both copies");
    assert_ne!(a1.offers, a2.offers, "each player has their own three");
    assert!(a1.offers.iter().all(|c| *c != forge_feel::cards::NO_CARD) && a1.state == forge_feel::cards::choice::CHOOSING);
    let mut other = run_core();
    other.sim.spawn_player(1, Vec3::ZERO, 0.0, true, true);
    other.sim.spawn_player(2, Vec3::X, 0.0, false, true);
    op(&mut other, forge_feel::op::REWARD, &[1, 3, 100, 0], &[20.0]);
    assert!(offers(&other, 1).unwrap().offers != a1.offers || offers(&other, 2).unwrap().offers != a2.offers, "another seed, another deal");

    // live: the host deals, the joiner's copy shows the host's deal and who is still choosing
    let (mut host, mut joiner) = pair(Vec3::new(0.0, 0.05, 0.0), Vec3::new(2.0, 0.05, 0.0));
    op(&mut host, forge_feel::op::REWARD, &[1, 3, 99, 0], &[20.0]);
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    assert_eq!((offers(&host, 1).unwrap().offers, offers(&host, 2).unwrap().offers), (a1.offers, a2.offers), "a host deals what the seed says");
    let jr = joiner.sim.res.get::<forge_feel::cards::Reward>().cloned().unwrap();
    assert!(jr.open && (jr.left - 19.9).abs() < 0.3 && jr.wave == 3, "the joiner sees the reward open with its countdown ({} s)", jr.left);
    assert_eq!((offers(&joiner, 1), offers(&joiner, 2)), (offers(&host, 1), offers(&host, 2)), "and the same cards, its own and its friend's");
    // a pick on the joiner's own copy does nothing: it is a command to the host
    op(&mut joiner, forge_feel::op::PICK, &[2, 1], &[]);
    assert!(cards_of(&joiner, 2).is_empty());
    // the host applies the joiner's pick (the kit sends it as a message): the card, on both copies, with what it changes
    let card = a2.offers[1];
    let before = forge_feel::cards::preview(&host.sim, host.player(2).unwrap(), card);
    op(&mut host, forge_feel::op::PICK, &[2, 1], &[]);
    for f in 12..24 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    assert_eq!((cards_of(&host, 2), cards_of(&joiner, 2)), (vec![card], vec![card]), "the pick survives the snapshot");
    let jc = offers(&joiner, 2).unwrap();
    assert_eq!((jc.state, jc.picked), (forge_feel::cards::choice::PICKED, 1));
    assert_eq!(offers(&joiner, 1).unwrap().state, forge_feel::cards::choice::CHOOSING, "the friend is still choosing, and the joiner's copy says so");
    // the inspector's numbers are what both copies now hold
    for ch in before["changes"].as_array().unwrap() {
        let (path, after) = (ch["path"].as_str().unwrap(), ch["after"].as_f64().unwrap());
        for c in [&host, &joiner] {
            assert_eq!(forge_feel::cards::value_of(&c.sim, c.player(2).unwrap(), path), Some(after), "{path} on both copies");
        }
    }
    let view = joiner.sim.res.get::<forge_feel::view::FeelView>().unwrap().v;
    assert_eq!((view[forge_feel::view::field::CARDS], view[forge_feel::view::field::REWARD], view[forge_feel::view::field::CHOICE]), (1.0, 1.0, 2.0));
    // the host passes: everyone has chosen, the reward closes after its linger and the rules hear it
    op(&mut host, forge_feel::op::PICK, &[1, 255], &[]);
    let mut done = 0;
    for f in 24..90 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
        done += rule_names(&host, &decoded(&host)).iter().filter(|r| *r == "reward-done").count();
    }
    assert_eq!(done, 1, "reward-done once, when everyone had picked or passed");
    assert!(!joiner.sim.res.get::<forge_feel::cards::Reward>().unwrap().open, "and the joiner's copy closes with it");
    assert_eq!(cards_of(&joiner, 2), vec![card], "the card stays after the reward");
}

/// INTEGRATION.md mismatch 16: a knock on the host is played by the joiner's prediction on the same step of its own
/// (the PUSH event names it), so nothing is corrected. Before wave 2 the joiner kept walking while the host had it
/// down, and was pulled back by up to 0.69 m.
#[test]
fn a_knock_on_the_host_starts_on_the_joiners_own_step_and_is_not_corrected() {
    let (mut host, mut joiner) = pair(Vec3::new(8.0, 0.05, 8.0), Vec3::new(0.0, 0.05, 20.0));
    let mut downs = 0;
    let (mut at_knock, mut far_x) = (Vec3::ZERO, f32::MIN);
    for f in 0..240 {
        // the joiner holds forward the whole time
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
        if f == 60 {
            let e = host.player(2).unwrap();
            at_knock = pos(&joiner, 2);
            forge_feel::controller::knock(&mut host.sim, e, Vec3::X, 6.0, 0.7);
            assert_eq!(host.sim.world.get::<&forge_feel::controller::Pilot>(e).unwrap().down, 0.0, "not yet: it waits for the joiner's own step");
        }
        let je = joiner.player(2).unwrap();
        if joiner.sim.world.get::<&forge_feel::controller::Pilot>(je).unwrap().down > 0.0 {
            downs += 1;
            far_x = far_x.max(pos(&joiner, 2).x);
        }
    }
    let n = joiner.net().unwrap().stats;
    eprintln!("co-op stats: {n:?}");
    assert_eq!((n.pushes, n.shoved), (1, 0), "the knock reached the joiner before its step and was played on it ({n:?})");
    assert!((40..=44).contains(&downs), "down for the knock's 0.7 s on the joiner's own screen ({downs} frames)");
    assert!(far_x > at_knock.x + 0.8, "pushed aside while down ({} → {far_x})", at_knock.x);
    assert!(n.checked > 30 && n.max_error < 0.06 && n.snapped == 0, "no correction through the knock: the worst {} m ({n:?})", n.max_error);
    assert!(pos(&joiner, 2).distance(pos(&host, 2)) < 0.6, "the host's copy follows a few steps behind, as in any walk");

    // a slow link: the host's snapshots reach the joiner 0.3 s after they were taken, so the knock is heard after its
    // step. What is left of it plays from there; the host has kept its copy where the joiner's own copy said it was
    // (net.rs "a joiner's word"), so there is nothing to catch up and nothing to correct
    let (mut host, mut joiner) = pair(Vec3::new(8.0, 0.05, 8.0), Vec3::new(0.0, 0.05, 20.0));
    let mut wire: std::collections::VecDeque<(usize, Vec<u8>)> = Default::default();
    for f in 0..330 {
        let moving = if f < 200 { 1.0 } else { 0.0 };
        both(&mut host, &mut joiner, f, (0.0, moving, 0, 0), (0.0, 0.0, 0, 0), true);
        if f % 6 == 5 {
            wire.push_back((f + 18, host.snapshot()));
        }
        while wire.front().is_some_and(|(at, _)| *at <= f) {
            joiner.apply(&wire.pop_front().unwrap().1).unwrap();
        }
        if f == 60 {
            let e = host.player(2).unwrap();
            forge_feel::controller::knock(&mut host.sim, e, Vec3::X, 6.0, 0.7);
        }
    }
    let n = joiner.net().unwrap().stats;
    eprintln!("co-op stats: {n:?}");
    assert_eq!((n.pushes, n.shoved), (0, 1), "heard late ({n:?})");
    assert!(n.max_shove == 0.0 && n.snapped == 0 && n.corrected == 0, "no catch-up move and no correction ({n:?})");
    assert!(n.max_error < 0.06, "the reconciliation finds nothing to correct ({} m)", n.max_error);
    assert!(n.last_error < 0.05 && pos(&joiner, 2).distance(pos(&host, 2)) < 0.1, "the two agree ({} vs {})", pos(&joiner, 2), pos(&host, 2));
    let q = &host.net().unwrap().queues[&2];
    eprintln!("the host's queue: taken {} (largest {} m), refused {}", q.taken, q.taken_max, q.refused);
    assert!(q.taken > 0 && q.refused == 0, "while the joiner had not heard, the host kept its copy where the joiner's was");

    // no snapshot at all for 0.7 s (a stall): the knock comes with a snapshot taken after it began, most of it gone.
    // The host's copy walked where the joiner's did meanwhile, so nothing snaps
    let (mut host, mut joiner) = pair(Vec3::new(8.0, 0.05, 8.0), Vec3::new(0.0, 0.05, 20.0));
    for f in 0..330 {
        let moving = if f < 200 { 1.0 } else { 0.0 };
        both(&mut host, &mut joiner, f, (0.0, moving, 0, 0), (0.0, 0.0, 0, 0), (60..100).contains(&f));
        if f == 60 {
            let e = host.player(2).unwrap();
            forge_feel::controller::knock(&mut host.sim, e, Vec3::X, 6.0, 0.7);
        }
    }
    let n = joiner.net().unwrap().stats;
    eprintln!("co-op stats: {n:?}");
    assert_eq!((n.shoved, n.snapped), (1, 0), "{n:?}");
    assert!(n.last_error < 0.05 && pos(&joiner, 2).distance(pos(&host, 2)) < 0.1, "after a stall the two agree again ({} vs {}; {n:?})", pos(&joiner, 2), pos(&host, 2));
}

/// INTEGRATION.md mismatch 16, what was left of it: a joiner never sees the enemies quite where the host has them, so
/// what stops its player differs by a step here and there, and every such step came back as a correction (0.4 to 1.1 m
/// in a crowd, `tools/coop-check.mjs --fight`). The host takes the joiner's word for where its own player is: through
/// the world alone, and only close to its own replay.
#[test]
fn the_host_takes_a_joiners_word_for_its_place_but_not_through_a_wall_or_from_afar() {
    // an enemy stands in the joiner's way on the host; the joiner's copy never hears of it (no snapshot) and walks
    // straight on. The host's copy of the joiner goes where the joiner went
    let (mut host, mut joiner) = pair(Vec3::new(20.0, 0.05, 0.0), Vec3::new(0.0, 0.05, 20.0));
    for id in [1, 2] {
        let e = host.player(id).unwrap();
        *host.sim.world.get::<&mut Health>(e).unwrap() = Health { armor: 0.0, ..Health::new(50000.0) };
    }
    let net = enemy(&mut host, 0, [0.0, 0.05, 12.0]);
    let mut worst = 0.0f32;
    for f in 0..150 {
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), true);
        if f > 20 {
            worst = worst.max(pos(&host, 2).x.abs());
        }
    }
    assert!(host.sim.entity_of(net).is_some() && joiner.sim.entity_of(net).is_none(), "only the host has the enemy");
    assert!(pos(&joiner, 2).z < 6.0 && pos(&joiner, 2).x.abs() < 0.01, "the joiner walked straight on ({})", pos(&joiner, 2));
    assert!(worst < 0.05 && pos(&host, 2).distance(pos(&joiner, 2)) < 0.6, "and the host's copy went with it, not round the enemy (off the line by {worst} m; {} vs {})", pos(&host, 2), pos(&joiner, 2));
    let q = host.net().unwrap().queues[&2].clone();
    eprintln!("the host's queue: taken {} (largest {} m), refused {}", q.taken, q.taken_max, q.refused);
    assert!(q.taken > 0 && q.taken_max < 0.5 && q.refused == 0, "the host's own replay was stopped by the enemy; it took the joiner's word {} times (largest {} m)", q.taken, q.taken_max);
    // the first snapshot after all that: nothing to correct
    joiner.apply(&host.snapshot()).unwrap();
    let n = joiner.net().unwrap().stats;
    assert!(n.checked == 1 && n.corrected == 0 && n.snapped == 0 && n.max_error < 0.03, "{n:?}");

    // a wall only the host has (a joiner's copy with the world wrong): the joiner's word does not take the host's copy
    // through it, and the joiner is put back
    let (mut host, mut joiner) = pair(Vec3::new(20.0, 0.05, 0.0), Vec3::new(0.0, 0.05, 20.0));
    let mut w = Writer::default();
    w.add_box([-6.0, 0.0, 14.0], [6.0, 3.0, 15.0]);
    send(&mut host, &w, 0.0);
    for f in 0..150 {
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let n = joiner.net().unwrap().stats;
    eprintln!("a wall only the host has: host {}, joiner {}, {n:?}", pos(&host, 2), pos(&joiner, 2));
    assert!(pos(&host, 2).z > 15.2, "the host's copy stayed on its side of the wall ({})", pos(&host, 2));
    assert!(n.corrected + n.snapped > 0 && pos(&joiner, 2).z > 14.0, "and the joiner was put back to it ({}; {n:?})", pos(&joiner, 2));

    // the host moves the joiner's player far away (a respawn the joiner has not heard of): its word is refused until
    // it has heard, and the joiner snaps there as it always did
    let (mut host, mut joiner) = pair(Vec3::new(20.0, 0.05, 0.0), Vec3::new(0.0, 0.05, 20.0));
    for f in 0..90 {
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
        if f == 40 {
            let e = host.player(2).unwrap();
            forge_core::net::teleport_player(&mut host.sim, e, Vec3::new(-15.0, 0.05, -15.0), 0.0, 0.0);
        }
    }
    let (n, q) = (joiner.net().unwrap().stats, host.net().unwrap().queues[&2].clone());
    eprintln!("a respawn on the host: host {}, joiner {}, {n:?}, refused {}", pos(&host, 2), pos(&joiner, 2), q.refused);
    assert!(q.refused > 0 && n.snapped == 1, "refused while the joiner had not heard, then one snap ({n:?}, refused {})", q.refused);
    assert!(pos(&joiner, 2).x < -10.0 && pos(&joiner, 2).distance(pos(&host, 2)) < 0.6, "the joiner is where the host put it ({} vs {})", pos(&joiner, 2), pos(&host, 2));
}

/// INTEGRATION.md mismatch 16, the other half: a joiner's own player is stopped by the host's enemies in its
/// prediction too (its copies of them have a body, carried forward to where the host will have them), and friends
/// walk through each other on every copy. Before wave 2 the joiner walked through enemies and into friends and was
/// corrected.
#[test]
fn a_joiners_player_is_stopped_by_an_enemy_as_on_the_host_and_walks_through_a_friend() {
    // the host's player stands in the joiner's way, then an enemy
    let (mut host, mut joiner) = pair(Vec3::new(0.0, 0.05, 16.0), Vec3::new(0.0, 0.05, 20.0));
    for id in [1, 2] {
        let e = host.player(id).unwrap();
        *host.sim.world.get::<&mut Health>(e).unwrap() = Health { armor: 0.0, ..Health::new(50000.0) };
    }
    let net = enemy(&mut host, 0, [0.0, 0.05, 8.0]);
    let (mut through_friend, mut nearest, mut worst_gap) = (false, f32::MAX, 0.0f32);
    for f in 0..170 {
        // forward (−Z): through the friend at z 16, then into the enemy that comes to meet it, and round it
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
        through_friend |= pos(&joiner, 2).z < 15.0;
        if let Some(e) = host.sim.entity_of(net) {
            let ep = host.sim.world.get::<&Transform>(e).unwrap().pos;
            nearest = nearest.min(Vec3::new(pos(&host, 2).x - ep.x, 0.0, pos(&host, 2).z - ep.z).length());
        }
        worst_gap = worst_gap.max(pos(&joiner, 2).distance(pos(&host, 2)));
    }
    assert!(through_friend, "friends do not block each other");
    let je = joiner.sim.entity_of(net).expect("the host's enemy on the joiner");
    assert!(joiner.sim.world.get::<&forge_core::physics::Body>(je).is_ok(), "the joiner's copy of it has a body");
    assert!((0.5..0.75).contains(&nearest), "on the host the player ran into the enemy's body and slid round it (nearest {nearest} m, two capsules)");
    let n = joiner.net().unwrap().stats;
    eprintln!("co-op stats: {n:?}");
    assert!(n.checked > 20 && n.max_error < 0.3 && n.snapped == 0, "the worst correction running into an enemy and through a friend: {} m ({n:?})", n.max_error);
    assert!(worst_gap < 1.2, "the two copies of the player never part further than the walk's own lag ({worst_gap} m)");
}

/// Down and revive with a friend: the host decides, the joiner's copy shows it (its own player down, the revive's
/// progress, back up at 40%); a friend holding interact within reach revives in the table's 2 s; the look of a downed
/// player turns slowly on its own copy; when both are down nobody is.
#[test]
fn a_friend_revives_a_downed_player_and_both_copies_agree() {
    use forge_feel::controller::Pilot;
    let (mut host, mut joiner) = pair(Vec3::new(0.0, 0.05, 0.0), Vec3::new(1.5, 0.05, 0.0));
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let (h2, j2) = (host.player(2).unwrap(), joiner.player(2).unwrap());
    host.sim.damage(h2, 500.0, 0, None, Vec3::Z);
    let mut names = Vec::new();
    for f in 12..36 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
        names.extend(rule_names(&host, &decoded(&host)));
    }
    assert!(names.iter().any(|n| n == "player-down") && names.iter().any(|n| n == "player-dead"), "{names:?}");
    assert!(host.sim.world.get::<&Pilot>(h2).unwrap().downed, "down on the host: a friend stands");
    assert!(joiner.sim.world.get::<&Health>(j2).unwrap().dead && joiner.sim.world.get::<&Pilot>(j2).unwrap().downed, "and on the joiner's own copy");
    let v = joiner.sim.res.get::<forge_feel::view::FeelView>().unwrap().v;
    assert_eq!((v[forge_feel::view::field::DOWNED], v[forge_feel::view::field::DEAD]), (1.0, 1.0));
    assert!(joiner.sim.world.get::<&LookScale>(j2).is_ok_and(|s| (s.0 - 0.35).abs() < 1e-6), "its look turns slowly");
    // a downed player's own input does nothing; a look of 1 rad turns 0.35
    let yaw0 = joiner.sim.world.get::<&Look>(j2).unwrap().yaw;
    let mut w = Writer::default();
    w.input(2, 0.0, 1.0, 1.0, 0.0, cmd::BTN_FIRE, true, cmd::BTN_FIRE);
    send(&mut joiner, &w, 1.0 / 60.0);
    let turned = forge_core::wrap(yaw0 - joiner.sim.world.get::<&Look>(j2).unwrap().yaw);
    assert!((turned - 0.35).abs() < 1e-4, "a slow look ({turned} rad for 1)");
    assert_eq!(joiner.sim.world.get::<&forge_feel::weapons::Arms>(j2).unwrap().shots, 0, "no fire while down");
    // the host's player holds interact beside it: 2 s
    let (mut revived_at, mut half) = (None, 0.0);
    for f in 36..200 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, cmd::BTN_INTERACT, 0), false);
        if f == 36 + 60 {
            half = joiner.sim.world.get::<&Pilot>(j2).unwrap().revive;
            assert_eq!(joiner.sim.world.get::<&Pilot>(j2).unwrap().reviver, 1, "the joiner's copy knows who is helping");
        }
        if revived_at.is_none() && rule_names(&host, &decoded(&host)).iter().any(|n| n == "player-revived") {
            revived_at = Some(f - 36);
        }
    }
    assert!((0.4..=0.55).contains(&half), "half way after a second, on the joiner's copy ({half})");
    let t = revived_at.expect("revived") as f32 / 60.0;
    assert!((1.95..=2.1).contains(&t), "a revive takes its 2 s ({t})");
    let (hh, jh) = (*host.sim.world.get::<&Health>(h2).unwrap(), *joiner.sim.world.get::<&Health>(j2).unwrap());
    assert!(!hh.dead && (hh.hp - 40.0).abs() < 0.01, "back at 40% on the host ({})", hh.hp);
    assert!(!jh.dead && (jh.hp - 40.0).abs() < 0.5 && !joiner.sim.world.get::<&Pilot>(j2).unwrap().downed, "and on the joiner ({})", jh.hp);
    assert!(joiner.sim.world.get::<&LookScale>(j2).is_err(), "its look is its own again");
    // out of reach nothing happens; both down: nobody is down, everyone is out
    let h1 = host.player(1).unwrap();
    host.sim.world.get::<&mut Health>(h2).unwrap().invulnerable = 0.0;
    host.sim.damage(h2, 500.0, 0, None, Vec3::Z);
    host.sim.teleport(h1, Vec3::new(-6.0, 0.05, 0.0));
    for f in 200..330 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, cmd::BTN_INTERACT, 0), false);
    }
    assert!(host.sim.world.get::<&Pilot>(h2).unwrap().downed && host.sim.world.get::<&Pilot>(h2).unwrap().revive == 0.0, "7.5 m away: no revive");
    host.sim.damage(h1, 500.0, 0, None, Vec3::Z);
    let mut out = 0;
    for f in 330..350 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
        out += rule_names(&host, &decoded(&host)).iter().filter(|n| *n == "player-out").count();
    }
    assert!(!host.sim.world.get::<&Pilot>(h2).unwrap().downed && !host.sim.world.get::<&Pilot>(h1).unwrap().downed && out == 1, "nobody stands: nobody is down, the run is lost");
    assert!(!joiner.sim.world.get::<&Pilot>(j2).unwrap().downed, "and the joiner's copy says so");
}

/// A wave's `friends` makes it bigger for each player after the first: more enemies, and a boss with more health (not
/// more bosses).
#[test]
fn a_wave_grows_with_the_number_of_players() {
    let tables = r#"{
      "weapons": [ { "id": "sidearm", "preset": "pistol" } ],
      "enemies": [ { "id": "grunt", "archetype": "chaser" }, { "id": "lord", "archetype": "boss", "health": 600 } ],
      "waves": [ { "id": "boss", "enemies": [ { "type": "grunt", "count": 4 }, { "type": "lord", "count": 1 } ], "boss": true, "friends": 0.5, "delay": 0.05, "spawnEvery": 0.05, "maxAlive": 30 } ]
    }"#;
    let run = |players: u32| -> (u32, u32, f32) {
        let mut c = core();
        c.load_tables(tables).unwrap();
        for id in 1..=players {
            c.sim.spawn_player(id, Vec3::new(id as f32 * 2.0, 0.05, 0.0), 0.0, id == 1, true);
        }
        op(&mut c, forge_ai::OP_DIRECTOR, &[1, 0], &[]);
        for _ in 0..120 {
            frame(&mut c, 1, 0.0, 0.0, 0, 0);
        }
        let boss_row = 1u16;
        let grunts = c.sim.world.query::<(&forge_ai::Enemy, &Kind)>().iter().filter(|(_, k)| k.type_ != boss_row).count() as u32;
        let bosses: Vec<f32> = c.sim.world.query::<(&forge_ai::Enemy, &Kind, &Health)>().iter().filter(|(_, k, _)| k.type_ == boss_row).map(|(_, _, h)| h.max).collect();
        (grunts, bosses.len() as u32, bosses.first().copied().unwrap_or(0.0))
    };
    assert_eq!(run(1), (4, 1, 600.0), "alone: the table's wave");
    assert_eq!(run(2), (6, 1, 900.0), "two players: half as much again");
    assert_eq!(run(4), (10, 1, 1500.0), "four: two and a half times, one boss");
}

/// The run's reward in the wave director's pause, natively: the wave that asks for a reward waits, the reward is
/// opened, picked and closed, the director goes on. (In a game gf/forge/ai.js and cards.js do the same from the rule
/// events.)
#[test]
fn the_director_waits_for_the_reward_and_goes_on_when_it_closes() {
    let mut c = run_core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    *c.sim.world.get::<&mut Health>(c.player(1).unwrap()).unwrap() = Health::new(50000.0);
    op(&mut c, forge_ai::OP_DIRECTOR, &[1, 0], &[]);
    let (mut seen, mut opened, mut picked) = (rule_names(&c, &decoded(&c)), false, false);
    for f in 0..(60 * 40) {
        // the first wave's two grunts are killed by a command as they rise (the fight itself is another test's)
        let targets: Vec<u32> = c.sim.world.query::<(&NetId, &forge_ai::Enemy, &Health)>().iter().filter(|(_, _, h)| !h.dead).map(|(n, ..)| n.0).collect();
        let mut w = Writer::default();
        w.input(1, 0.0, 0.0, 0.0, 0.0, 0, true, 0);
        if f % 30 == 29 && !opened {
            for t in targets {
                let mut p: Vec<u32> = vec![t, 500f32.to_bits(), 1];
                p.extend([0.0f32, 0.0, -1.0].map(f32::to_bits));
                w.op(cmd::DAMAGE, &p);
            }
        }
        send(&mut c, &w, 1.0 / 60.0);
        let mut names = rule_names(&c, &decoded(&c));
        if names.iter().any(|n| n == "wave-reward") {
            op(&mut c, forge_feel::op::REWARD, &[1, 1, 5, 0], &[0.0]);
            names.extend(rule_names(&c, &decoded(&c)));
            opened = true;
        } else if opened && !picked && c.sim.res.get::<forge_feel::cards::Reward>().is_some_and(|r| r.open) {
            op(&mut c, forge_feel::op::PICK, &[1, 0], &[]);
            names.extend(rule_names(&c, &decoded(&c)));
            picked = true;
        }
        if names.iter().any(|n| n == "reward-done") {
            op(&mut c, forge_ai::OP_DIRECTOR, &[2, 0], &[]);
            names.extend(rule_names(&c, &decoded(&c)));
        }
        seen.extend(names);
        if seen.iter().filter(|n| *n == "wave-start").count() == 2 {
            break;
        }
    }
    let order: Vec<&str> = seen.iter().map(String::as_str).filter(|n| ["wave-start", "wave-clear", "wave-reward", "reward-open", "card-picked", "reward-done"].contains(n)).collect();
    assert_eq!(order, ["wave-start", "wave-clear", "wave-reward", "reward-open", "card-picked", "reward-done", "wave-start"], "{seen:?}");
    assert_eq!(cards_of(&c, 1).len(), 1);
}

// ---- wave 7, track E: elites across the tracks and the copies ----

const ELITE_TABLES: &str = r#"{
  "weapons": [ { "id": "sidearm", "preset": "pistol" } ],
  "enemies": [ { "id": "grunt", "archetype": "chaser", "health": 60, "coins": 2, "speed": 0 } ],
  "elites": { "on": true, "coins": 3, "burning": { "dps": 4, "seconds": 2, "tick": 0.5 } }
}"#;

fn elite_core() -> Core {
    let mut c = core();
    c.load_tables(ELITE_TABLES).unwrap();
    c
}

/// An enemy of row 0 standing at `at`, an elite with modifier `m` (0: ordinary). → its net id.
fn elite_enemy(c: &mut Core, m: u32, at: [f32; 3]) -> u32 {
    let before: Vec<u32> = c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).collect();
    op(c, forge_ai::OP_SPAWN, &[0, 1, m], &[at[0], at[1], at[2], 0.0]);
    c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).find(|n| !before.contains(n)).expect("the enemy spawned")
}

fn coins_thrown(c: &Core) -> usize {
    c.sim.world.query::<(&Kind, &Local)>().iter().filter(|(k, _)| k.kind == forge_feel::kinds::COIN).count()
}

/// An elite's kill throws its row's coins times `elites.coins` (forge-feel's kills read forge-core's `Marked` bounty); the
/// `coin` rule event each one scores by is the same as any coin's.
#[test]
fn an_elites_kill_throws_its_coins_times_the_multiplier() {
    let mut c = elite_core();
    c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let plain = elite_enemy(&mut c, 0, [-2.0, 0.05, -6.0]);
    let fast = elite_enemy(&mut c, forge_ai::elite::Mod::Fast as u32, [2.0, 0.05, -6.0]);
    let e = c.sim.entity_of(plain).unwrap();
    c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    frame(&mut c, 1, 0.0, 0.0, 0, 0);
    frame(&mut c, 1, 0.0, 0.0, 0, 0);
    let n_plain = coins_thrown(&c);
    let e = c.sim.entity_of(fast).unwrap();
    c.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    frame(&mut c, 1, 0.0, 0.0, 0, 0);
    frame(&mut c, 1, 0.0, 0.0, 0, 0);
    let n_elite = coins_thrown(&c) - n_plain;
    assert_eq!((n_plain, n_elite), (2, 6), "an ordinary kill's 2 coins, an elite's 2 × 3");
    // they fly to the player and score as any coin does
    let mut scored = 0.0;
    for _ in 0..240 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
        for (ev, _) in decoded(&c) {
            if let Event::Rule(r) = ev
                && c.sim.names.get(r.name) == "coin"
            {
                scored += r.a;
            }
        }
    }
    assert_eq!(scored, 8.0, "eight coins picked up");
}

/// A joiner's copy of the host's elite carries its mark (the snapshot's actor flags), its AI view says it, and a split
/// elite's young is drawn small there as on the host; an ordinary enemy is drawn at its type's size.
#[test]
fn a_joiners_copy_sees_the_elites_modifier_and_draws_a_split_ones_young_small() {
    let (mut host, mut joiner) = (elite_core(), elite_core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    host.sim.spawn_player(1, Vec3::new(0.0, 0.05, 6.0), 0.0, true, true);
    host.sim.spawn_player(2, Vec3::new(2.0, 0.05, 6.0), 0.0, false, true);
    joiner.sim.spawn_player(2, Vec3::new(2.0, 0.05, 6.0), 0.0, true, true);
    let iron = elite_enemy(&mut host, forge_ai::elite::Mod::Armoured as u32, [-2.0, 0.05, -4.0]);
    let plain = elite_enemy(&mut host, 0, [0.0, 0.05, -4.0]);
    let split = elite_enemy(&mut host, forge_ai::elite::Mod::Splitting as u32, [3.0, 0.05, -4.0]);
    // the splitting one falls: its two young crawl out on the host
    let e = host.sim.entity_of(split).unwrap();
    host.sim.damage(e, 1.0e6, 1, None, Vec3::Z);
    for _ in 0..12 {
        frame(&mut host, 1, 0.0, 0.0, 0, 0);
    }
    joiner.apply(&host.snapshot()).unwrap();
    frame(&mut joiner, 2, 0.0, 0.0, 0, 0);
    let view = |c: &Core, net: u32| {
        let v = c.sim.res.get::<forge_ai::view::AiView>().unwrap();
        (0..v.count).find(|i| v.rows[forge_ai::view::field::NET * forge_ai::view::CAPACITY + i] as u32 == net).map(|i| v.rows[forge_ai::view::field::ELITE * forge_ai::view::CAPACITY + i] as u8)
    };
    let je = joiner.sim.entity_of(iron).expect("the elite on the joiner");
    assert!(joiner.sim.world.get::<&Replica>(je).is_ok());
    assert_eq!(joiner.sim.world.get::<&Marked>(je).unwrap().mark, forge_ai::elite::Mod::Armoured as u8);
    assert_eq!((view(&host, iron), view(&joiner, iron)), (Some(2), Some(2)), "the AI view says armoured on both copies");
    assert_eq!(view(&joiner, plain), Some(0));
    let scale = host.sim.res.get::<forge_ai::Roster>().unwrap().def(0).scale;
    let jp = joiner.sim.entity_of(plain).unwrap();
    assert!((joiner.sim.world.get::<&Transform>(jp).unwrap().scale - scale).abs() < 1e-5, "an ordinary one at its type's size on the joiner too");
    let young: Vec<u32> = host.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().filter(|(_, e)| e.mark & forge_ai::elite::CHILD != 0).map(|(n, _)| n.0).collect();
    assert_eq!(young.len(), 2);
    for n in young {
        let h = host.sim.world.get::<&Transform>(host.sim.entity_of(n).unwrap()).unwrap().scale;
        let j = joiner.sim.world.get::<&Transform>(joiner.sim.entity_of(n).expect("the young on the joiner")).unwrap().scale;
        assert!((h - scale * 0.7).abs() < 1e-5 && (j - h).abs() < 1e-5, "small on both copies ({h}, {j})");
        assert_eq!(view(&joiner, n), Some(forge_ai::elite::CHILD));
    }
    // the hit an armoured elite takes is the host's to decide: half
    let he = host.sim.entity_of(iron).unwrap();
    assert_eq!(host.sim.damage(he, 20.0, 2, None, Vec3::Z).damage, 10.0);
}

/// Burning on a joiner's player is the host's to apply (it simulates every player): the joiner hears it as the rule
/// `burning`, sees the embers, and its health goes down by the host's bites.
#[test]
fn a_joiners_player_set_alight_burns_on_the_host_and_the_joiner_sees_it() {
    let (mut host, mut joiner) = (elite_core(), elite_core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    host.sim.spawn_player(1, Vec3::new(0.0, 0.05, 6.0), 0.0, true, true);
    host.sim.spawn_player(2, Vec3::new(2.0, 0.05, 6.0), 0.0, false, true);
    joiner.sim.spawn_player(2, Vec3::new(2.0, 0.05, 6.0), 0.0, true, true);
    let p2 = host.player(2).unwrap();
    let hp_of = |c: &Core, e| {
        let h = c.sim.world.get::<&Health>(e).unwrap();
        h.hp + h.armor
    };
    let start = hp_of(&host, p2);
    forge_ai::elite::ignite(&mut host.sim, p2, 300, 4.0, 2.0);
    let (mut told, mut embers) = (false, 0);
    let ember = joiner.sim.names.id("embers");
    for f in 0..180 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
        for (ev, flags) in decoded(&joiner) {
            match ev {
                Event::Rule(r) if joiner.sim.names.get(r.name) == "burning" && r.entity == 2 => told |= flags & events::FLAG_REMOTE != 0,
                Event::Particles(p) if p.name == ember => embers += 1,
                _ => {}
            }
        }
    }
    assert!(told, "the joiner heard it burns (the host's rule event)");
    assert!(embers >= 3, "and saw embers on it ({embers})");
    let host_hp = hp_of(&host, p2);
    let join_hp = hp_of(&joiner, joiner.player(2).unwrap());
    assert!((start - host_hp - 8.0).abs() < 1e-3, "four bites of 2 on the host ({start} → {host_hp})");
    assert!((join_hp - host_hp).abs() < 1.0, "the joiner's health follows the host's ({join_hp} against {host_hp})");
    assert!(joiner.sim.res.get::<forge_ai::elite::EliteState>().is_none_or(|s| s.burns.is_empty()), "the joiner simulates no burn of its own");
}

// ---- wave 7, track P: coins worth spending (the purse, the pedlar's cart, a paid revive) ----

const SHOP: &str = r#"{ "on": true, "seconds": 8, "items": [
  { "id": "letter", "kind": "card", "price": 10, "perLap": 1.5, "perBuy": 1.5, "stock": 2 },
  { "id": "deal", "kind": "reroll", "price": 4, "stock": 3 },
  { "id": "broth", "kind": "heal", "price": 5, "share": 0.5, "stock": 1 },
  { "id": "stone", "kind": "hone", "price": 8, "by": 0.5, "stock": 2 },
  { "id": "salts", "kind": "revive", "price": 6, "perLap": 1.5, "perBuy": 1.5, "stock": 0 } ] }"#;

/// The run's tables with the cart (and other waves, or endless, when given).
fn with_shop(waves: Option<&str>, endless: Option<&str>) -> String {
    use forge_core::serde_json::{self, Value};
    let mut t: Value = serde_json::from_str(RUN_TABLES).unwrap();
    t["shop"] = serde_json::from_str(SHOP).unwrap();
    if let Some(w) = waves {
        t["waves"] = serde_json::from_str(w).unwrap();
    }
    if let Some(e) = endless {
        t["endless"] = serde_json::from_str(e).unwrap();
    }
    t.to_string()
}

fn shop_pair(h: Vec3, j: Vec3) -> (Core, Core) {
    let (mut host, mut joiner) = pair(h, j);
    let t = with_shop(None, None);
    host.load_tables(&t).unwrap();
    joiner.load_tables(&t).unwrap();
    (host, joiner)
}

fn coins(c: &Core, id: u32) -> u32 {
    forge_feel::shop::coins(&c.sim, id)
}

/// Every rule event of the last step: (name, entity, a, b, c, d).
fn rules_full(c: &Core) -> Vec<(String, u32, f32, f32, f32, f32)> {
    decoded(c).into_iter().filter_map(|(e, _)| if let Event::Rule(r) = e { Some((c.sim.names.get(r.name).to_string(), r.entity, r.a, r.b, r.c, r.d)) } else { None }).collect()
}

/// A kill's coin goes into the purse of the player it reached, on the host, and the snapshot brings every player's purse
/// to the joiner's copy (the HUD shows it from there). A joiner's copy never fills a purse itself.
#[test]
fn the_purse_fills_from_a_kill_and_reaches_the_joiner() {
    let (mut host, mut joiner) = shop_pair(Vec3::new(0.0, 0.05, 0.0), Vec3::new(2.0, 0.05, 0.0));
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let g = enemy(&mut host, 0, [0.0, 0.05, -3.0]);
    let by = host.sim.world.get::<&NetId>(host.player(1).unwrap()).unwrap().0;
    let mut w = Writer::default();
    let mut p = vec![g, 500f32.to_bits(), by];
    p.extend([0.0f32, 0.0, -1.0].map(f32::to_bits));
    w.op(cmd::DAMAGE, &p);
    send(&mut host, &w, 0.0);
    let mut coin_events = 0;
    for f in 12..150 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
        coin_events += rules_full(&host).iter().filter(|r| r.0 == "coin" && r.1 == 1).count();
    }
    assert_eq!(coin_events, 1, "the grunt's one coin reached the nearest player");
    assert_eq!((coins(&host, 1), coins(&joiner, 1)), (1, 1), "into their purse, on both copies");
    forge_feel::shop::earn(&mut host.sim, 2, 7.0);
    forge_feel::shop::earn(&mut joiner.sim, 2, 5.0);
    for f in 150..170 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    assert_eq!((coins(&host, 2), coins(&joiner, 2)), (7, 7), "the joiner's own purse is the host's word");
}

/// A card honed at the cart is honed on the joiner's copy too, so the joiner predicts its own player with the honed
/// value the host replays it with (no corrections), and the cart, the purse and the prices are the same on both.
#[test]
fn a_hone_reaches_the_joiner_and_its_prediction_walks_with_it() {
    use forge_feel::shop::Shop;
    let (mut host, mut joiner) = shop_pair(Vec3::new(8.0, 0.05, 8.0), Vec3::new(0.0, 0.05, 20.0));
    op(&mut host, forge_feel::op::CARD, &[2, 0], &[]);
    forge_feel::shop::earn(&mut host.sim, 2, 50.0);
    op(&mut host, forge_feel::op::SHOP, &[1, 1, 9, 0, 0], &[0.0]);
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let js = joiner.sim.res.get::<Shop>().cloned().unwrap();
    assert!(js.open && js.visitors[&2].in_cart && js.visitors[&1].in_cart && (js.left - 7.8).abs() < 0.3, "the joiner sees the cart open ({} s)", js.left);
    assert_eq!(forge_feel::shop::price_for(&joiner.sim, 2, 3), Some(8));
    // the joiner's own copy does not sell: a purchase is a command to the host
    op(&mut joiner, forge_feel::op::BUY, &[2, 3, 0], &[]);
    assert_eq!(coins(&joiner, 2), 50);
    op(&mut host, forge_feel::op::BUY, &[2, 3, 0], &[]);
    for f in 12..24 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let walk = 7.8 * 1.2f32.powf(1.5);
    let (hw, jw) = (forge_feel::cards::of(&host.sim, host.player(2).unwrap()).player.walk, forge_feel::cards::of(&joiner.sim, joiner.player(2).unwrap()).player.walk);
    assert!((hw - walk).abs() < 1e-3 && (jw - walk).abs() < 1e-3, "×1.2 honed once is ×1.2^1.5 on both copies ({hw}, {jw})");
    assert_eq!((coins(&host, 2), coins(&joiner, 2)), (42, 42));
    assert_eq!(forge_feel::shop::price_for(&joiner.sim, 2, 3), Some(12), "the next hone costs more, and the joiner's copy says so");
    let n = joiner.net().unwrap().stats;
    let (mut from, mut speed) = (Vec3::ZERO, 0.0);
    for f in 24..204 {
        both(&mut host, &mut joiner, f, (0.0, 1.0, 0, 0), (0.0, 0.0, 0, 0), false);
        if f == 143 {
            from = pos(&joiner, 2);
        }
        if f == 203 {
            speed = pos(&joiner, 2).distance(from);
        }
    }
    let n2 = joiner.net().unwrap().stats;
    assert!((speed - walk).abs() < 0.06, "the joiner walks the honed walk ({speed} m in a second)");
    assert!(n2.corrected - n.corrected <= 1 && n2.last_error < 0.05, "and the host replays it alike ({n2:?})");
}

/// The director waits for the cart on a wave without a reward, and goes on when everyone has left it (one player) or
/// its time is up (two, one staying); the next lap's cart is dearer.
#[test]
fn the_director_waits_for_the_cart_and_goes_on_when_everyone_left_or_the_time_is_up() {
    let waves = r#"[ { "id": "one", "enemies": [ { "type": "grunt", "count": 1 } ], "delay": 0.1, "spawnEvery": 0.1 }, { "id": "two", "enemies": [ { "type": "grunt", "count": 1 } ], "delay": 0.1, "spawnEvery": 0.1 } ]"#;
    let tables = with_shop(Some(waves), Some(r#"{ "on": true, "from": 1 }"#));
    for players in [1u32, 2] {
        let mut c = core();
        c.load_tables(&tables).unwrap();
        for id in 1..=players {
            let e = c.sim.spawn_player(id, Vec3::new(id as f32 * 2.0, 0.05, 0.0), 0.0, id == 1, true);
            *c.sim.world.get::<&mut Health>(e).unwrap() = Health::new(50000.0);
        }
        op(&mut c, forge_ai::OP_DIRECTOR, &[1, 0], &[]);
        let mut seen: Vec<(String, u32, f32, f32, f32, f32)> = rules_full(&c);
        let (mut opened_at, mut done_at, mut t, mut carts) = (0.0f32, Vec::new(), 0.0f32, 0);
        for f in 0..(60 * 60) {
            let targets: Vec<u32> = c.sim.world.query::<(&NetId, &forge_ai::Enemy, &Health)>().iter().filter(|(_, _, h)| !h.dead).map(|(n, ..)| n.0).collect();
            let mut w = Writer::default();
            for id in 1..=players {
                w.input(id, 0.0, 0.0, 0.0, 0.0, 0, true, 0);
            }
            if f % 30 == 29 {
                for g in targets {
                    let mut p: Vec<u32> = vec![g, 500f32.to_bits(), 1];
                    p.extend([0.0f32, 0.0, -1.0].map(f32::to_bits));
                    w.op(cmd::DAMAGE, &p);
                }
            }
            send(&mut c, &w, 1.0 / 60.0);
            t += 1.0 / 60.0;
            let mut now = rules_full(&c);
            if let Some(r) = now.iter().find(|r| r.0 == "wave-reward").cloned() {
                assert_eq!((r.4, r.5), (0.0, 1.0), "no reward, the cart: {r:?}");
                op(&mut c, forge_feel::op::SHOP, &[1, r.2 as u32, 5, 0, 0], &[0.0]);
                now.extend(rules_full(&c));
                opened_at = t;
                carts += 1;
                // alone the player leaves at once; with a friend only the host does, and the friend stays
                op(&mut c, forge_feel::op::BUY, &[1, forge_feel::shop::LEAVE, 0], &[]);
                now.extend(rules_full(&c));
            }
            if now.iter().any(|r| r.0 == "shop-done") {
                done_at.push(t - opened_at);
                op(&mut c, forge_ai::OP_DIRECTOR, &[2, 0], &[]);
                now.extend(rules_full(&c));
            }
            seen.extend(now);
            if carts == 3 && done_at.len() == 3 {
                break;
            }
        }
        let order: Vec<&str> = seen.iter().map(|r| r.0.as_str()).filter(|n| ["wave-start", "wave-clear", "wave-reward", "shop-open", "shop-left", "shop-done", "lap"].contains(n)).take(7).collect();
        assert_eq!(order, ["wave-start", "wave-clear", "wave-reward", "shop-open", "shop-left", "shop-done", "wave-start"], "{players} player(s): {seen:?}");
        assert_eq!(done_at.len(), 3, "{players} player(s): three carts ({seen:?})");
        if players == 1 {
            assert!(done_at.iter().all(|d| *d < 0.05), "alone: the cart closes the step after the player leaves ({done_at:?})");
        } else {
            assert!(done_at.iter().all(|d| (7.9..=8.1).contains(d)), "two: the friend who stays keeps it open for its 8 s ({done_at:?})");
        }
        // the third cart is the second lap's: dearer by perLap
        let laps: Vec<f32> = seen.iter().filter(|r| r.0 == "shop-open").map(|r| r.4).collect();
        assert_eq!(laps, [0.0, 0.0, 1.0], "the cart after wave 1, after wave 2, then the next lap's first: {seen:?}");
        assert_eq!(forge_feel::shop::price_for(&c.sim, 1, 0), Some(15), "the card at 10 × 1.5 on lap 1");
    }
}

/// A joiner pays to raise a downed friend from anywhere: the host checks it and raises them, both copies agree, the
/// second costs more; a revive by holding interact beside them stays free; too few coins is refused.
#[test]
fn a_joiner_pays_to_raise_a_downed_friend_and_a_held_revive_stays_free() {
    use forge_feel::controller::Pilot;
    let (mut host, mut joiner) = shop_pair(Vec3::new(0.0, 0.05, 0.0), Vec3::new(1.5, 0.05, 0.0));
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    forge_feel::shop::earn(&mut host.sim, 2, 20.0);
    let (h1, j1) = (host.player(1).unwrap(), joiner.player(1).unwrap());
    host.sim.damage(h1, 500.0, 0, None, Vec3::Z);
    for f in 12..30 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    assert!(host.sim.world.get::<&Pilot>(h1).unwrap().downed && joiner.sim.world.get::<&Pilot>(j1).unwrap().downed);
    assert_eq!(forge_feel::shop::price_for(&joiner.sim, 2, 4), Some(6), "the joiner's copy knows the price");
    op(&mut joiner, forge_feel::op::BUY, &[2, 4, 1], &[]);
    op(&mut host, forge_feel::op::BUY, &[2, 4, 1], &[]);
    let ev = rules_full(&host);
    assert!(ev.iter().any(|r| r.0 == "bought" && r.1 == 2 && r.2 == 4.0 && r.3 == 6.0 && r.4 == 1.0), "{ev:?}");
    assert!(ev.iter().any(|r| r.0 == "player-revived" && r.1 == 1 && r.2 == 2.0), "raised by the payer: {ev:?}");
    for f in 30..42 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    for c in [&host, &joiner] {
        let e = c.player(1).unwrap();
        assert!(!c.sim.world.get::<&Health>(e).unwrap().dead && !c.sim.world.get::<&Pilot>(e).unwrap().downed, "up on both copies");
        assert_eq!(coins(c, 2), 14);
    }
    assert_eq!(forge_feel::shop::price_for(&joiner.sim, 2, 4), Some(9), "the second this visit: 6 × 1.5");
    // down again: a revive by holding interact beside them costs nothing
    host.sim.world.get::<&mut Health>(h1).unwrap().invulnerable = 0.0;
    host.sim.damage(h1, 500.0, 0, None, Vec3::Z);
    let mut raised = false;
    for f in 42..240 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, cmd::BTN_INTERACT, 0), (0.0, 0.0, 0, 0), false);
        raised |= rules_full(&host).iter().any(|r| r.0 == "player-revived" && r.1 == 1 && r.2 == 2.0);
    }
    assert!(raised, "held beside them: back up");
    assert_eq!((coins(&host, 2), coins(&joiner, 2)), (14, 14), "and free");
    // too few coins: refused, nothing spent
    host.sim.world.get::<&mut Health>(h1).unwrap().invulnerable = 0.0;
    host.sim.damage(h1, 500.0, 0, None, Vec3::Z);
    for f in 240..252 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    forge_feel::shop::set_purse(&mut host.sim, 2, 5);
    op(&mut host, forge_feel::op::BUY, &[2, 4, 1], &[]);
    assert!(rules_full(&host).iter().any(|r| r.0 == "buy-refused" && r.1 == 2 && r.3 == forge_feel::shop::why::COINS as f32));
    assert!(host.sim.world.get::<&Pilot>(h1).unwrap().downed && coins(&host, 2) == 5);
}

// ---- wave 7, the merge: builds (B), elites (E) and the purse and cart (P) together ----

/// One player's town with a perk card of each kind the joins need, elite-ready grunts and the cart. The grunts do no
/// harm (damage 0) and stand still, so nothing but the perk under test touches anyone.
const JOIN_TABLES: &str = r#"{
  "player": { "health": 100 },
  "weapons": [ { "id": "sidearm", "preset": "pistol", "damage": 20 } ],
  "enemies": [ { "id": "grunt", "archetype": "chaser", "health": 1000, "coins": 2, "speed": 0, "damage": 0 },
               { "id": "weak", "archetype": "chaser", "health": 10, "coins": 2, "speed": 0, "damage": 0 } ],
  "elites": { "on": true, "coins": 3, "health": 1, "armoured": { "damage": 0.5 } },
  "families": [ { "id": "tank", "label": "Tank", "at": 3, "bonus": { "perk": "shockwave" } },
                { "id": "blast", "label": "Blast", "at": 3, "bonus": { "perk": "burst" } } ],
  "deal": { "familyBias": 3 },
  "cards": [
    { "id": "oil", "kind": "perk", "perk": "burst", "family": "blast", "power": { "radius": 4, "damage": 40 } },
    { "id": "coals", "kind": "perk", "perk": "aura", "family": "tank", "power": { "radius": 4, "damage": 10 } },
    { "id": "bell", "kind": "perk", "perk": "shockwave", "family": "tank", "power": { "radius": 5, "damage": 30, "knockback": 0, "cooldown": 1 } },
    { "id": "barbs", "kind": "perk", "perk": "thorns", "family": "tank", "power": { "radius": 3, "damage": 16 } },
    { "id": "powder", "kind": "perk", "perk": "blast", "family": "blast", "power": { "radius": 3, "share": 0.5 } },
    { "id": "fleet", "stat": "player.walk", "mul": 1.2, "family": "tank" },
    { "id": "keen", "stat": "weapons.*.critMultiplier", "add": 0.5, "family": "blast" },
    { "id": "quick", "stat": "weapons.*.reload", "mul": 0.7 },
    { "id": "light", "stat": "player.stamina.evadeCost", "mul": 0.6 },
    { "id": "chase", "kind": "perk", "perk": "rush", "power": { "seconds": 2, "speed": 0.5, "rate": 1 } },
    { "id": "pebble-a", "stat": "player.walk", "add": 0.001, "stack": 9 },
    { "id": "pebble-b", "stat": "player.walk", "add": 0.001, "stack": 9 },
    { "id": "pebble-c", "stat": "player.walk", "add": 0.001, "stack": 9 },
    { "id": "pebble-d", "stat": "player.walk", "add": 0.001, "stack": 9 }
  ]
}"#;

fn join_core() -> Core {
    use forge_core::serde_json::{self, Value};
    let mut t: Value = serde_json::from_str(JOIN_TABLES).unwrap();
    t["shop"] = serde_json::from_str(SHOP).unwrap();
    let mut c = core();
    c.load_tables(&t.to_string()).unwrap();
    c
}

fn card_row(c: &Core, id: &str) -> u8 {
    forge_feel::cfg(&c.sim).cards.iter().position(|d| d.id == id).unwrap_or_else(|| panic!("card {id}")) as u8
}

fn hp_lost(c: &Core, net: u32, max: f32) -> f32 {
    c.sim.entity_of(net).and_then(|e| c.sim.world.get::<&Health>(e).ok().map(|h| max - h.hp)).unwrap_or(max)
}

/// A burst (a perk's own kill, credited to the player) that fells an elite pays the elite's coins × the bounty into the
/// killer's purse, once: the trigger's 2 coins and the elite's 2 × 3, eight coins and eight points, not more.
#[test]
fn a_perk_burst_that_fells_an_elite_pays_its_bounty_into_the_purse_once() {
    let mut c = join_core();
    let p = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let oil = card_row(&c, "oil");
    assert!(forge_feel::cards::grant(&mut c.sim, p, oil));
    // the trigger: a weak one (10 hp); beside it a weak elite, which the burst's 40 fells
    let trigger = {
        let before: Vec<u32> = c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).collect();
        op(&mut c, forge_ai::OP_SPAWN, &[1, 1, 0], &[0.0, 0.05, -6.0, 0.0]);
        c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).find(|n| !before.contains(n)).unwrap()
    };
    let before: Vec<u32> = c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).collect();
    op(&mut c, forge_ai::OP_SPAWN, &[1, 1, forge_ai::elite::Mod::Fast as u32], &[2.0, 0.05, -6.0, 0.0]);
    let elite = c.sim.world.query::<(&NetId, &forge_ai::Enemy)>().iter().map(|(n, _)| n.0).find(|n| !before.contains(n)).unwrap();
    assert!(c.sim.world.get::<&Marked>(c.sim.entity_of(elite).unwrap()).is_ok_and(|m| (m.bounty - 3.0).abs() < 1e-6), "an elite, bounty 3");
    let by = c.sim.world.get::<&NetId>(p).unwrap().0;
    let t = c.sim.entity_of(trigger).unwrap();
    c.sim.damage(t, 1.0e6, by, None, Vec3::NEG_Z);
    let (mut kills_by_player, mut coin_points, mut coin_events) = (0, 0.0, 0);
    for _ in 0..300 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
        for (ev, _) in decoded(&c) {
            match ev {
                Event::Kill(k) if k.target == elite => {
                    assert_eq!(k.attacker, by, "the burst's kill is the player's");
                    kills_by_player += 1;
                }
                Event::Rule(r) if c.sim.names.get(r.name) == "coin" => {
                    coin_points += r.a;
                    coin_events += 1;
                }
                _ => {}
            }
        }
    }
    assert_eq!(kills_by_player, 1, "the burst felled the elite once");
    assert_eq!((coin_events, coin_points), (8, 8.0), "2 coins for the trigger, 2 × 3 for the elite, each scored once");
    assert_eq!(coins(&c, 1), 8, "all eight in the killer's purse");
    let tally = c.sim.res.get::<forge_feel::perks::Tally>().unwrap().perks[forge_feel::perks::BURST];
    assert!(tally.kills >= 1, "the burst's tally counts the kill ({tally:?})");
}

/// An armoured elite takes `armoured.damage` (here half) of every perk's damage as of a weapon's: the burst, the aura,
/// the shockwave, the thorns and the blast all go through `Sim::damage`, which applies forge-core's `Marked.taken`.
#[test]
fn an_armoured_elite_takes_half_of_every_perks_damage() {
    use forge_feel::perks::{AURA, BLAST, BURST, SHOCKWAVE, THORNS};
    let pairs = |c: &mut Core, a: [f32; 3], b: [f32; 3]| (elite_enemy(c, 0, a), elite_enemy(c, forge_ai::elite::Mod::Armoured as u32, b));
    let mut got = Vec::new();
    for (kind, card) in [(BURST, "oil"), (AURA, "coals"), (SHOCKWAVE, "bell"), (THORNS, "barbs"), (BLAST, "powder")] {
        let mut c = join_core();
        let p = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
        *c.sim.world.get::<&mut Health>(p).unwrap() = Health::new(1.0e6);
        let row = card_row(&c, card);
        assert!(forge_feel::cards::grant(&mut c.sim, p, row));
        let by = c.sim.world.get::<&NetId>(p).unwrap().0;
        let (plain, iron) = match kind {
            // round a felled weak one 6 m out: both 2 m from it
            BURST => {
                let w = enemy(&mut c, 1, [0.0, 0.05, -6.0]);
                let pi = pairs(&mut c, [-2.0, 0.05, -6.0], [2.0, 0.05, -6.0]);
                let e = c.sim.entity_of(w).unwrap();
                c.sim.damage(e, 100.0, by, None, Vec3::NEG_Z);
                pi
            }
            // both 2.5 m from the player
            AURA | SHOCKWAVE => pairs(&mut c, [-2.5, 0.05, 0.0], [2.5, 0.05, 0.0]),
            // thorns bite the striker: each strikes the player once, from 2 m
            THORNS => {
                let (a, b) = pairs(&mut c, [-2.0, 0.05, 0.0], [2.0, 0.05, 0.0]);
                for s in [a, b] {
                    c.sim.damage(p, 1.0, s, None, Vec3::X);
                    frame(&mut c, 1, 0.0, 0.0, 0, 0);
                }
                (a, b)
            }
            // a shot lands on a third one between them: both 1.5 m from where it lands
            _ => {
                let mid = enemy(&mut c, 0, [0.0, 0.05, -6.0]);
                let pi = pairs(&mut c, [-1.5, 0.05, -6.0], [1.5, 0.05, -6.0]);
                let m = c.sim.entity_of(mid).unwrap();
                let d = forge_feel::cards::of(&c.sim, p).weapons[0].clone();
                let h = forge_core::sim::TraceHit { entity: Some(m), net: mid, dist: 6.0, point: Vec3::new(0.0, 1.0, -6.0), normal: Vec3::Z, part: Part::Body, region: 0, damage: 1.0, crit: false };
                forge_feel::weapons::strike(&mut c.sim, &d, by, m, &h, 20.0, Vec3::NEG_Z);
                pi
            }
        };
        if kind == SHOCKWAVE {
            c.sim.damage(p, 1.0, 0, None, Vec3::X);
        }
        let steps = if kind == AURA { 60 } else { 2 };
        for _ in 0..steps {
            frame(&mut c, 1, 0.0, 0.0, 0, 0);
        }
        let (a, b) = (hp_lost(&c, plain, 1000.0), hp_lost(&c, iron, 1000.0));
        got.push((card, a, b));
        assert!(a > 0.0, "{card}: the plain one was hurt ({a})");
        assert!((b - a * 0.5).abs() < 1e-3, "{card}: the armoured one took half ({b} of {a})");
    }
    eprintln!("perk damage, plain against armoured: {got:?}");
}

/// The whetstone hones an upgrade card and refuses a perk card cleanly: `buy-refused` with why TARGET, no coins spent,
/// nothing honed. (The kit's cart offers only upgrade cards to hone, gf/forge/shop.js; the core says why if asked.)
#[test]
fn a_hone_on_a_perk_card_is_refused_cleanly_and_an_upgrade_beside_it_is_honed() {
    let mut c = join_core();
    let p = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let (oil, fleet) = (card_row(&c, "oil"), card_row(&c, "fleet"));
    assert!(forge_feel::cards::grant(&mut c.sim, p, oil) && forge_feel::cards::grant(&mut c.sim, p, fleet));
    forge_feel::shop::earn(&mut c.sim, 1, 40.0);
    op(&mut c, forge_feel::op::SHOP, &[1, 1, 9, 0, 0], &[0.0]);
    assert!(forge_feel::shop::honeable(&c.sim, p, 0).is_none(), "a perk card is not honeable");
    let burst_before = forge_feel::cards::of(&c.sim, p).perks.get(forge_feel::perks::BURST).unwrap();
    op(&mut c, forge_feel::op::BUY, &[1, 3, 0], &[]);
    let ev = rules_full(&c);
    assert!(ev.iter().any(|r| r.0 == "buy-refused" && r.1 == 1 && r.2 == 3.0 && r.3 == forge_feel::shop::why::TARGET as f32), "{ev:?}");
    assert_eq!(coins(&c, 1), 40, "nothing spent");
    assert!(forge_feel::shop::levels(&c.sim, 1).iter().all(|l| *l == 0), "nothing honed");
    assert_eq!(forge_feel::cards::of(&c.sim, p).perks.get(forge_feel::perks::BURST).unwrap(), burst_before, "the perk as it was");
    // the upgrade beside it: honed, and paid for
    op(&mut c, forge_feel::op::BUY, &[1, 3, 1], &[]);
    assert!(rules_full(&c).iter().any(|r| r.0 == "bought" && r.1 == 1 && r.2 == 3.0));
    assert_eq!((coins(&c, 1), forge_feel::shop::levels(&c.sim, 1)), (32, vec![0, 1]));
    let walk = forge_feel::cards::of(&c.sim, p).player.walk;
    assert!((walk - 7.8 * 1.2f32.powf(1.5)).abs() < 1e-3, "×1.2 honed once ({walk})");
    // and the perk still holds, with both families counted (a hone changes no family)
    assert_eq!(forge_feel::cards::of(&c.sim, p).perks.counts, vec![1, 1]);
    assert_eq!(forge_feel::cards::of(&c.sim, p).perks.get(forge_feel::perks::BURST).unwrap(), burst_before);
}

/// Zombie Town's own Blast family (the spec's tables, elites and cart on): a kill bursts onto a shambler beside it, and a
/// round that lands splashes it, with the game's own numbers (the wave 7 merge's check of the tracks on the real game).
#[test]
fn zombie_towns_blast_family_bursts_and_splashes_onto_a_shambler_beside_the_one_hit() {
    use forge_core::serde_json::Value;
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../specs/zombie-town.spec.json")).expect("research/gf-forge/specs/zombie-town.spec.json");
    let spec: Value = forge_core::serde_json::from_str(&text).unwrap();
    let mut c = core();
    c.load_tables(&spec["forge"].to_string()).unwrap();
    let p = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    *c.sim.world.get::<&mut Health>(p).unwrap() = Health::new(1.0e6);
    for id in ["black-powder", "lamp-oil", "powder-horn"] {
        let r = card_row(&c, id);
        assert!(forge_feel::cards::grant(&mut c.sim, p, r), "{id}");
    }
    assert_eq!(forge_feel::cards::of(&c.sim, p).perks.bonuses.len(), 1, "three of the Powder Guild: Chain of Fuses");
    let by = c.sim.world.get::<&NetId>(p).unwrap().0;
    let shambler = 0;
    let (a, b) = (enemy(&mut c, shambler, [0.0, 0.05, -6.0]), enemy(&mut c, shambler, [1.5, 0.05, -6.0]));
    let max = c.sim.world.get::<&Health>(c.sim.entity_of(b).unwrap()).unwrap().max;
    // a round lands on a: the blast splashes b
    let ea = c.sim.entity_of(a).unwrap();
    let d = forge_feel::cards::of(&c.sim, p).weapons[0].clone();
    let at = c.sim.world.get::<&Transform>(ea).unwrap().pos;
    let h = forge_core::sim::TraceHit { entity: Some(ea), net: a, dist: 6.0, point: at + Vec3::Y, normal: Vec3::Z, part: Part::Body, region: 0, damage: 1.0, crit: false };
    forge_feel::weapons::strike(&mut c.sim, &d, by, ea, &h, 10.0, Vec3::NEG_Z);
    let splashed = hp_lost(&c, b, max);
    // then a falls: the burst catches b
    c.sim.damage(ea, 1.0e6, by, None, Vec3::NEG_Z);
    for _ in 0..3 {
        frame(&mut c, 1, 0.0, 0.0, 0, 0);
    }
    let burst = hp_lost(&c, b, max) - splashed;
    let t = c.sim.res.get::<forge_feel::perks::Tally>().unwrap().perks;
    eprintln!("zombie town blast family: splash {splashed}, burst {burst}, blast {:?}, burst {:?}", t[forge_feel::perks::BLAST], t[forge_feel::perks::BURST]);
    assert!(splashed > 0.0 && t[forge_feel::perks::BLAST].hits >= 1, "the blast splashed the shambler beside it ({splashed})");
    assert!(burst > 0.0 && t[forge_feel::perks::BURST].hits >= 1, "the burst caught it ({burst})");
}

/// A full hand (32 cards: the cart's cards fill one in a long run) is dealt nothing: the reward passes it by itself,
/// and the cart shows no cards (a card bought is refused, why TARGET, nothing spent), where both once dealt three that
/// could not be taken.
#[test]
fn a_full_hand_is_dealt_nothing_by_the_reward_or_a_sealed_letter() {
    let mut c = join_core();
    let p = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let pebbles: Vec<u8> = ["pebble-a", "pebble-b", "pebble-c", "pebble-d"].iter().map(|id| card_row(&c, id)).collect();
    for k in 0..32 {
        assert!(forge_feel::cards::grant(&mut c.sim, p, pebbles[k % 4]));
    }
    assert!(!forge_feel::cards::grant(&mut c.sim, p, pebbles[0]), "32: the hand is full");
    op(&mut c, forge_feel::op::REWARD, &[1, 2, 77, 0], &[0.0]);
    let ch = c.sim.res.get::<forge_feel::cards::Reward>().unwrap().choices[&1];
    assert_eq!((ch.offers, ch.state), ([forge_feel::cards::NO_CARD; 3], forge_feel::cards::choice::PASSED), "nothing dealt, passed");
    forge_feel::shop::earn(&mut c.sim, 1, 50.0);
    op(&mut c, forge_feel::op::SHOP, &[1, 2, 77, 0, 0], &[0.0]);
    assert_eq!(c.sim.res.get::<forge_feel::shop::Shop>().unwrap().visitors[&1].offers, [forge_feel::cards::NO_CARD; 3], "no cards on show");
    op(&mut c, forge_feel::op::BUY, &[1, 0, 0], &[]);
    assert!(rules_full(&c).iter().any(|r| r.0 == "buy-refused" && r.1 == 1 && r.2 == 0.0 && r.3 == forge_feel::shop::why::TARGET as f32));
    assert_eq!(coins(&c, 1), 50, "nothing spent");
}

/// v8 (the creator: "We should only have one selection system", then "Cart only, no free cards"): with no reward the cart
/// opens with three cards on show for each player for two minutes; the joiner's copy shows its own three and their
/// prices as the host has them; a card bought is the host's word (taken, its place empty on both copies, its price out
/// of the purse); a fresh deal deals the three again on both copies.
#[test]
fn the_cart_alone_shows_each_player_three_cards_and_sells_them_on_both_copies() {
    use forge_feel::cards::NO_CARD;
    use forge_feel::shop::{card_price, Shop};
    let (mut host, mut joiner) = shop_pair(Vec3::new(0.0, 0.05, 0.0), Vec3::new(2.0, 0.05, 0.0));
    for f in 0..12 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    forge_feel::shop::earn(&mut host.sim, 2, 60.0);
    op(&mut host, forge_feel::op::SHOP, &[1, 1, 9, 0, 0], &[120.0]);
    for f in 12..24 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let (hs, js) = (host.sim.res.get::<Shop>().cloned().unwrap(), joiner.sim.res.get::<Shop>().cloned().unwrap());
    for id in [1u32, 2] {
        assert!(hs.visitors[&id].offers.iter().all(|k| *k != NO_CARD), "player {id}: three on show");
        assert_eq!(js.visitors[&id].offers, hs.visitors[&id].offers, "player {id}: the same three on the joiner's copy");
    }
    assert_ne!(hs.visitors[&1].offers, hs.visitors[&2].offers, "each player's own three");
    assert!((js.left - 120.0).abs() < 1.0, "two minutes on the joiner's copy too ({} s)", js.left);
    let price = card_price(&joiner.sim, 2, 2).unwrap();
    assert_eq!(card_price(&host.sim, 2, 2), Some(price), "the price the joiner sees is the host's");
    let card = hs.visitors[&2].offers[2];
    // the joiner's own copy does not sell: the purchase is the host's
    op(&mut joiner, forge_feel::op::BUY, &[2, 0, 2], &[]);
    assert_eq!(coins(&joiner, 2), 60);
    op(&mut host, forge_feel::op::BUY, &[2, 0, 2], &[]);
    for f in 24..36 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    assert_eq!((cards_of(&host, 2), cards_of(&joiner, 2)), (vec![card], vec![card]), "taken, on both copies");
    assert_eq!((coins(&host, 2), coins(&joiner, 2)), (60 - price, 60 - price));
    let js = joiner.sim.res.get::<Shop>().cloned().unwrap();
    assert_eq!(js.visitors[&2].offers[2], NO_CARD, "its place empty on the joiner's copy");
    // a fresh deal (row 1): three again, on both copies
    let before = host.sim.res.get::<Shop>().unwrap().visitors[&2].offers;
    op(&mut host, forge_feel::op::BUY, &[2, 1, 0], &[]);
    for f in 36..48 {
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let (h2, j2) = (host.sim.res.get::<Shop>().unwrap().visitors[&2].offers, joiner.sim.res.get::<Shop>().unwrap().visitors[&2].offers);
    assert!(h2 != before && h2.iter().all(|k| *k != NO_CARD) && h2 == j2, "dealt again: {before:?} → {h2:?} (joiner {j2:?})");
}

/// A fresh deal at the cart is the reward's three dealt again with a salt, and it leans toward the families the player
/// has started as the reward's own deal does (the lean is in `deal_salted`, so a paid three and a reroll lean too).
#[test]
fn a_reroll_at_the_cart_deals_again_and_still_leans_toward_a_started_family() {
    let mut c = join_core();
    let p = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 0.0), 0.0, true, true);
    let bell = card_row(&c, "bell");
    assert!(forge_feel::cards::grant(&mut c.sim, p, bell));
    // the reward, then the cart beside it; a fresh deal (row 1) bought
    op(&mut c, forge_feel::op::REWARD, &[1, 2, 77, 0], &[0.0]);
    forge_feel::shop::earn(&mut c.sim, 1, 20.0);
    op(&mut c, forge_feel::op::SHOP, &[1, 2, 77, 0, 1], &[0.0]);
    let offers = |c: &Core| c.sim.res.get::<forge_feel::cards::Reward>().unwrap().choices[&1].offers;
    let first = offers(&c);
    op(&mut c, forge_feel::op::BUY, &[1, 1, 0], &[]);
    assert!(rules_full(&c).iter().any(|r| r.0 == "bought" && r.1 == 1 && r.2 == 1.0), "the fresh deal sold");
    let again = offers(&c);
    assert_ne!(first, again, "another three");
    let cfg = forge_feel::cfg(&c.sim);
    for o in again {
        let d = &cfg.cards[o as usize];
        assert!(d.weight > 0.0 && !(o == bell && d.stack <= 1), "{} is a card the player can take", d.id);
    }
    // the lean, over many seeds, at the reroll's salt: tank cards (the bell aside) dealt more once the bell is held
    let tank: Vec<u8> = cfg.cards.iter().enumerate().filter(|(i, d)| d.family == Some(0) && *i as u8 != bell).map(|(i, _)| i as u8).collect();
    let count = |held: &[u8], defs: &[forge_feel::cards::CardDef]| (0..1500u64).map(|s| forge_feel::cards::deal_salted(defs, cfg.deal.rarity, s, 1, 1, forge_feel::shop::SALT_REROLL + 1, held, &[0]).iter().filter(|c| tank.contains(c)).count()).sum::<usize>();
    let flat: Vec<forge_feel::cards::CardDef> = cfg.cards.iter().map(|d| forge_feel::cards::CardDef { bias: 1.0, ..d.clone() }).collect();
    let (leaned, unleaned) = (count(&[bell], &cfg.cards), count(&[bell], &flat));
    assert!(leaned as f32 > unleaned as f32 * 1.4, "a rerolled three leans toward the tank cards: {leaned} against {unleaned}");
}

/// The worst case a joiner's snapshot carries for each of four players: a full hand (32 cards), a rush, a full cart part
/// (open, the cards on show, purchases) and every card honed, beside an armoured elite's mark. It fits `BLOB_MAX`,
/// and the joiner reads the build, the cart and the mark back together.
#[test]
fn a_joiners_snapshot_carries_the_build_the_cart_and_an_elites_mark_together_for_four_full_players() {
    use forge_feel::shop::Shop;
    let (mut host, mut joiner) = (join_core(), join_core());
    host.net_role(Role::Host, 1, 0);
    joiner.net_role(Role::Joiner, 2, 7);
    let pebbles: Vec<u8> = ["pebble-a", "pebble-b", "pebble-c", "pebble-d"].iter().map(|id| card_row(&host, id)).collect();
    let (oil, chase) = (card_row(&host, "oil"), card_row(&host, "chase"));
    for id in 1..=4u32 {
        let e = host.sim.spawn_player(id, Vec3::new(id as f32 * 2.0, 0.05, 6.0), 0.0, id == 1, true);
        assert!(forge_feel::cards::grant(&mut host.sim, e, oil) && forge_feel::cards::grant(&mut host.sim, e, chase));
        // 31 now: a full hand is dealt nothing, so the cart deals at 31 and the 32nd card is bought from it
        for k in 0..29 {
            assert!(forge_feel::cards::grant(&mut host.sim, e, pebbles[k % 4]));
        }
        forge_feel::shop::earn(&mut host.sim, id, 300.0 + id as f32);
        // every card honed (the most the bytes say), and a rush going
        forge_feel::shop::set_levels(&mut host.sim, id, vec![forge_feel::shop::HONE_MAX; 32]);
        let _ = host.sim.world.insert_one(e, forge_feel::perks::Perks { rush: 2.0, rush_total: 2.0, ..Default::default() });
    }
    joiner.sim.spawn_player(2, Vec3::new(4.0, 0.05, 6.0), 0.0, true, true);
    let iron = elite_enemy(&mut host, forge_ai::elite::Mod::Armoured as u32, [0.0, 0.05, -4.0]);
    op(&mut host, forge_feel::op::SHOP, &[1, 3, 11, 0, 0], &[0.0]);
    // each buys the first of the three on show (the 32nd card): the purchases set, two cards still on show
    for id in 1..=4u32 {
        op(&mut host, forge_feel::op::BUY, &[id, 0, 0], &[]);
        let e = host.player(id).unwrap();
        assert_eq!(host.sim.world.get::<&forge_feel::cards::Build>(e).unwrap().cards.len(), 32, "player {id} bought its 32nd");
    }
    // the rush is kept up on the host for the test (a real one runs out in its seconds)
    for f in 0..12 {
        for id in 1..=4u32 {
            if let Some(e) = host.player(id)
                && let Ok(mut pk) = host.sim.world.get::<&mut forge_feel::perks::Perks>(e)
            {
                pk.rush = 2.0;
            }
        }
        both(&mut host, &mut joiner, f, (0.0, 0.0, 0, 0), (0.0, 0.0, 0, 0), false);
    }
    let bytes = host.snapshot();
    let snap = forge_core::snapshot::decode(&bytes).unwrap();
    assert_eq!(snap.players.len(), 4);
    let worst = forge_feel::cards::blob::HEAD + forge_feel::cards::MAX_CARDS + forge_feel::shop::bytes::HEAD + 32;
    assert!(worst <= forge_core::snapshot::BLOB_MAX, "the worst case {worst} fits BLOB_MAX {}", forge_core::snapshot::BLOB_MAX);
    for b in &snap.blobs {
        assert_eq!(b.len(), worst, "every player's bytes at the worst case ({worst})");
        let t = forge_feel::cards::decode(b);
        assert_eq!((t.cards.len(), t.rush, t.extra.len()), (32, 15, forge_feel::shop::bytes::HEAD + 32));
    }
    assert!(snap.actors.iter().any(|a| a.id == iron && a.mark == forge_ai::elite::Mod::Armoured as u8), "the elite's mark rides the same snapshot");
    eprintln!("four full players and an elite: a snapshot of {} bytes, each player's part {worst}", bytes.len());
    // the joiner's copy: its own player's build (cards, perks, rush), every purse, the cart and the hones, and the mark
    joiner.apply(&bytes).unwrap();
    frame(&mut joiner, 2, 0.0, 0.0, 0, 0);
    let j2 = joiner.player(2).unwrap();
    assert_eq!(cards_of(&joiner, 2), cards_of(&host, 2));
    assert!(forge_feel::cards::of(&joiner.sim, j2).perks.get(forge_feel::perks::BURST).is_some(), "the perks from the cards");
    assert!(forge_feel::cards::of(&joiner.sim, j2).perks.get(forge_feel::perks::RUSH).is_some());
    assert!(joiner.sim.world.get::<&forge_feel::perks::Perks>(j2).is_ok_and(|p| p.rush > 0.0), "the rush from byte 0");
    let js = joiner.sim.res.get::<Shop>().cloned().unwrap();
    let hs = host.sim.res.get::<Shop>().cloned().unwrap();
    assert!(js.open && js.visitors.get(&2).is_some_and(|v| v.in_cart && v.offers == hs.visitors[&2].offers && v.offers[0] == forge_feel::cards::NO_CARD && v.offers[1] != forge_feel::cards::NO_CARD), "the cart open, the cards on show as the host has them");
    for id in 1..=4u32 {
        assert_eq!(coins(&joiner, id), coins(&host, id), "player {id}'s purse");
    }
    assert_eq!(forge_feel::shop::levels(&joiner.sim, 2), vec![forge_feel::shop::HONE_MAX; 32]);
    let je = joiner.sim.entity_of(iron).expect("the elite on the joiner");
    assert_eq!(joiner.sim.world.get::<&Marked>(je).unwrap().mark, forge_ai::elite::Mod::Armoured as u8);
}

/// After a cart at a lap's end the next wave is the next lap's, and its enemies are that lap's (damage and speed too:
/// track E's fix to wave 6's growth, through track P's cart pause).
#[test]
fn after_the_cart_the_next_lap_rises_with_that_laps_damage_and_speed() {
    use forge_core::serde_json::{self, json, Value};
    let waves = r#"[ { "id": "one", "enemies": [ { "type": "grunt", "count": 1 } ], "delay": 0.1, "spawnEvery": 0.1 } ]"#;
    let mut tables: Value = serde_json::from_str(&with_shop(Some(waves), Some(r#"{ "on": true, "from": 0, "grow": { "damage": 0.5, "speed": 0.2, "health": 0 }, "speedMost": 2 }"#))).unwrap();
    tables["enemies"][0]["speed"] = json!(3.0);
    tables["enemies"][0]["damage"] = json!(10.0);
    let mut c = core();
    c.load_tables(&tables.to_string()).unwrap();
    let e = c.sim.spawn_player(1, Vec3::new(0.0, 0.05, 30.0), 0.0, true, true);
    *c.sim.world.get::<&mut Health>(e).unwrap() = Health::new(1.0e6);
    op(&mut c, forge_ai::OP_DIRECTOR, &[1, 0], &[]);
    let (mut seen, mut carts) = (Vec::new(), 0);
    for f in 0..(60 * 30) {
        let mut w = Writer::default();
        w.input(1, 0.0, 0.0, 0.0, 0.0, 0, true, 0);
        if f % 20 == 19 {
            let alive: Vec<(u32, u16)> = c.sim.world.query::<(&NetId, &forge_ai::Enemy, &Health)>().iter().filter(|(_, _, h)| !h.dead).map(|(n, en, _)| (n.0, en.def)).collect();
            for (g, def) in alive {
                let lap = c.sim.res.get::<forge_ai::director::Director>().unwrap().lap;
                let d = c.sim.res.get::<forge_ai::Roster>().unwrap().by_index(def).into_owned();
                seen.push((lap, d.damage, d.speed));
                let mut p: Vec<u32> = vec![g, 1.0e6f32.to_bits(), 1];
                p.extend([0.0f32, 0.0, -1.0].map(f32::to_bits));
                w.op(cmd::DAMAGE, &p);
            }
        }
        send(&mut c, &w, 1.0 / 60.0);
        for r in rules_full(&c) {
            if r.0 == "wave-reward" && r.5 == 1.0 {
                carts += 1;
                op(&mut c, forge_feel::op::SHOP, &[1, r.2 as u32, 5, 0, 0], &[0.0]);
                op(&mut c, forge_feel::op::BUY, &[1, forge_feel::shop::LEAVE, 0], &[]);
            }
            if r.0 == "shop-done" {
                op(&mut c, forge_ai::OP_DIRECTOR, &[2, 0], &[]);
            }
        }
        if seen.iter().any(|s| s.0 >= 2) {
            break;
        }
    }
    let at = |lap: u32| seen.iter().find(|s| s.0 == lap).copied().unwrap_or_else(|| panic!("lap {lap} reached: {seen:?}"));
    let (l0, l1, l2) = (at(0), at(1), at(2));
    assert!(carts >= 2, "a cart after each wave ({carts})");
    assert!((l0.1 - 10.0).abs() < 1e-4 && (l0.2 - 3.0).abs() < 1e-4, "lap 0 as the row: {l0:?}");
    assert!(l1.1 > l0.1 * 1.4 && l2.1 > l1.1 * 1.2, "the damage grows each lap after a cart: {seen:?}");
    assert!(l1.2 > l0.2 && l2.2 > l1.2, "and the speed: {seen:?}");
}
