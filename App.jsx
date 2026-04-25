import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc
} from "firebase/firestore";
import {
  Clipboard,
  Crown,
  Eye,
  LogIn,
  MessageCircle,
  Play,
  Plus,
  Send,
  Trophy,
  Users
} from "lucide-react";
import { db, ensureAnonymousUser } from "./firebase.js";

const QUESTIONS = [
  {
    text: "Wie hoch ist der Eiffelturm in Metern?",
    answer: 330,
    unit: "m",
    tips: [
      "Aus 1 km Entfernung wirkt der Eiffelturm ungefähr wie ein Gegenstand von rund 20 cm in der Hand.",
      "Er ist höher als der Berliner Fernsehturm bis zur Aussichtsplattform, aber niedriger als dessen Antenne."
    ]
  },
  {
    text: "Wie viele Knochen hat ein erwachsener Mensch?",
    answer: 206,
    unit: "Knochen",
    tips: [
      "Babys haben deutlich mehr, weil einige Knochen erst später zusammenwachsen.",
      "Die Zahl liegt knapp über 200."
    ]
  },
  {
    text: "Wie lang ist ein Fußballfeld in der Bundesliga im Normalfall?",
    answer: 105,
    unit: "m",
    tips: [
      "Internationale Spielfelder liegen meist um die 100 Meter.",
      "Die typische Breite dazu beträgt 68 Meter."
    ]
  },
  {
    text: "Wie viele Minuten dauert ein reguläres Eishockeyspiel netto?",
    answer: 60,
    unit: "Minuten",
    tips: [
      "Es wird in drei gleich lange Drittel aufgeteilt.",
      "Die Uhr stoppt bei Unterbrechungen."
    ]
  }
];

const STARTING_COINS = 1000;
const BASE_SMALL_BLIND = 25;
const BASE_BIG_BLIND = 50;
const STEP = 25;

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function getBlindLevel(roundNumber) {
  return Math.floor(Math.max(0, roundNumber - 1) / 2);
}

function getBlinds(roundNumber) {
  const multiplier = 2 ** getBlindLevel(roundNumber);
  return {
    smallBlind: BASE_SMALL_BLIND * multiplier,
    bigBlind: BASE_BIG_BLIND * multiplier
  };
}

function normalizeMoney(value) {
  return Math.max(0, Math.round(Number(value || 0) / STEP) * STEP);
}

function useRoom(roomCode) {
  const [room, setRoom] = useState(null);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(Boolean(roomCode));

  useEffect(() => {
    if (!roomCode) {
      setRoom(null);
      setPlayers([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const roomRef = doc(db, "rooms", roomCode);
    const unsubRoom = onSnapshot(roomRef, (snap) => {
      setRoom(snap.exists() ? { id: snap.id, ...snap.data() } : null);
      setLoading(false);
    });
    const playersQuery = query(collection(db, "rooms", roomCode, "players"), orderBy("seat", "asc"));
    const unsubPlayers = onSnapshot(playersQuery, (snap) => {
      setPlayers(snap.docs.map((playerDoc) => ({ id: playerDoc.id, ...playerDoc.data() })));
    });

    return () => {
      unsubRoom();
      unsubPlayers();
    };
  }, [roomCode]);

  return { room, players, loading };
}

function Logo() {
  return (
    <div className="logoWrap">
      <div className="logoMark">TRY's</div>
      <div>
        <p className="kicker">Spielmaster</p>
        <h1>Two Tipps One Cup</h1>
      </div>
    </div>
  );
}

function Home({ onHost, onJoin }) {
  const [roomName, setRoomName] = useState("");
  const [joinCode, setJoinCode] = useState("");

  return (
    <main className="shell home">
      <section className="hero">
        <Logo />
        <div className="heroGrid">
          <div className="panel">
            <h2>Host Einstellungen</h2>
            <label>
              Raumname
              <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="z. B. Samstag Abend" />
            </label>
            <button className="primary" onClick={() => onHost(roomName)}>
              <Plus size={18} />
              Raum erstellen
            </button>
          </div>
          <div className="panel">
            <h2>Raum beitreten</h2>
            <label>
              Raumcode
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="ABCD12" />
            </label>
            <button className="secondary" onClick={() => joinCode.trim() && onJoin(joinCode.trim())}>
              <LogIn size={18} />
              Weiter
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function Invite({ roomCode, roomName, onContinue }) {
  const joinUrl = `${window.location.origin}/join/${roomCode}`;
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`Komm in meinen Two Tipps One Cup Raum: ${joinUrl}`)}`;

  return (
    <main className="shell">
      <Logo />
      <section className="panel invite">
        <p className="kicker">Raum erstellt</p>
        <h2>{roomName || "Neuer Spielraum"}</h2>
        <div className="roomCode">{roomCode}</div>
        <div className="copyLine">{joinUrl}</div>
        <div className="buttonRow">
          <a className="primary" href={whatsappUrl} target="_blank" rel="noreferrer">
            <MessageCircle size={18} />
            per WhatsApp senden
          </a>
          <button className="secondary" onClick={() => navigator.clipboard.writeText(joinUrl)}>
            <Clipboard size={18} />
            Link kopieren
          </button>
          <button className="ghost" onClick={onContinue}>
            <Users size={18} />
            Zur Lobby
          </button>
        </div>
      </section>
    </main>
  );
}

function Join({ roomCode, onJoined }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function joinRoom() {
    if (!name.trim()) return;
    setBusy(true);
    const user = await ensureAnonymousUser();
    const roomRef = doc(db, "rooms", roomCode);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) {
      alert("Diesen Raum gibt es nicht.");
      setBusy(false);
      return;
    }

    const playersSnap = await getDoc(doc(db, "rooms", roomCode, "meta", "counter"));
    const nextSeat = playersSnap.exists() ? Number(playersSnap.data().nextSeat || 0) : 0;
    await setDoc(doc(db, "rooms", roomCode, "players", user.uid), {
      name: name.trim(),
      coins: STARTING_COINS,
      committed: 0,
      folded: false,
      answered: false,
      answer: null,
      seat: nextSeat,
      role: roomSnap.data().hostId === user.uid ? "host" : "player",
      joinedAt: serverTimestamp()
    });
    await setDoc(doc(db, "rooms", roomCode, "meta", "counter"), { nextSeat: nextSeat + 1 }, { merge: true });
    onJoined(roomCode, user.uid);
  }

  return (
    <main className="shell">
      <Logo />
      <section className="panel narrow">
        <p className="kicker">Raumcode</p>
        <div className="roomCode small">{roomCode}</div>
        <label>
          Dein Name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Spielername" />
        </label>
        <button className="primary" disabled={busy} onClick={joinRoom}>
          <Send size={18} />
          Spiel beitreten
        </button>
      </section>
    </main>
  );
}

function Lobby({ room, players, isHost, onStart }) {
  return (
    <main className="shell">
      <Logo />
      <section className="layout">
        <div className="panel">
          <p className="kicker">Warteraum</p>
          <h2>{room.name}</h2>
          <p className="soft">Bitte warten, bis der Host das Spiel startet.</p>
          <div className="players">
            {players.map((player) => (
              <div className="playerRow" key={player.id}>
                <span>{player.name}</span>
                <strong>{player.coins} Coins</strong>
              </div>
            ))}
          </div>
          {isHost && (
            <button className="primary" disabled={players.length < 2} onClick={onStart}>
              <Play size={18} />
              Spiel starten
            </button>
          )}
        </div>
        <div className="panel rules">
          <h2>Kurzregeln</h2>
          <p>Jeder Spieler startet mit 1000 Coins. Small Blind beginnt bei 25 Coins, Big Blind bei 50 Coins.</p>
          <p>Nach jeweils zwei kompletten Table-Runden verdoppeln sich die Blinds: 50/100, danach 100/200 und so weiter.</p>
          <p>Alle geben verdeckt eine Zahlenantwort ab. Danach wird gesetzt, Tipp 1 erscheint, es wird gesetzt, Tipp 2 erscheint, es wird gesetzt, dann gewinnt die Antwort mit der kleinsten Entfernung zur Lösung.</p>
          <p>Setzen geht nur in 25er-Schritten. Fold spart weitere Coins, kann den Pot aber nicht mehr gewinnen.</p>
        </div>
      </section>
    </main>
  );
}

function PlayerTable({ players, currentTurn }) {
  return (
    <div className="table">
      {players.map((player) => (
        <div className={`seat ${player.id === currentTurn ? "active" : ""} ${player.folded ? "folded" : ""}`} key={player.id}>
          <span>{player.name}</span>
          <strong>{player.coins}</strong>
          <small>gesetzt: {player.committed || 0}</small>
        </div>
      ))}
    </div>
  );
}

function Game({ room, players, userId }) {
  const [answerInput, setAnswerInput] = useState("");
  const [raiseInput, setRaiseInput] = useState("");
  const me = players.find((player) => player.id === userId);
  const activePlayers = players.filter((player) => !player.folded);
  const currentQuestion = QUESTIONS[room.questionIndex % QUESTIONS.length];
  const isHost = room.hostId === userId;
  const currentBet = Math.max(0, ...players.map((player) => player.committed || 0));
  const isMyTurn = room.currentTurn === userId;
  const blinds = getBlinds(room.roundNumber || 1);

  const winnerText = useMemo(() => {
    if (!room.result) return "";
    return room.result.winners?.length ? `${room.result.winners.join(", ")} gewinnt ${room.result.pot} Coins` : "";
  }, [room.result]);

  async function submitAnswer() {
    const numeric = Number(answerInput.replace(",", "."));
    if (!Number.isFinite(numeric)) return;
    await updateDoc(doc(db, "rooms", room.id, "players", userId), {
      answer: numeric,
      answered: true
    });
    setAnswerInput("");
  }

  function nextTurnFrom(list, afterId) {
    const eligible = list.filter((player) => !player.folded && player.coins > 0);
    if (!eligible.length) return null;
    const index = eligible.findIndex((player) => player.id === afterId);
    return eligible[(index + 1 + eligible.length) % eligible.length]?.id || eligible[0].id;
  }

  async function act(type, amount = 0) {
    if (!me || !isMyTurn) return;
    const playerRef = doc(db, "rooms", room.id, "players", userId);
    const updates = {};
    let nextCommitted = me.committed || 0;

    if (type === "fold") {
      updates.folded = true;
    } else {
      const target = normalizeMoney(amount);
      const required = type === "check" ? nextCommitted : Math.max(target, currentBet);
      const pay = Math.max(0, Math.min(me.coins, required - nextCommitted));
      updates.committed = nextCommitted + pay;
      updates.coins = me.coins - pay;
      nextCommitted = updates.committed;
    }

    await updateDoc(playerRef, updates);
    const updatedPlayers = players.map((player) => (player.id === userId ? { ...player, ...updates } : player));
    const remaining = updatedPlayers.filter((player) => !player.folded);
    if (remaining.length <= 1) {
      await finishRound(updatedPlayers);
      return;
    }

    const settled = remaining.every((player) => (player.committed || 0) === Math.max(...remaining.map((p) => p.committed || 0)));
    const nextTurn = nextTurnFrom(updatedPlayers, userId);
    if (settled && nextTurn === room.bettingStart) {
      await advanceStreet(updatedPlayers);
    } else {
      await updateDoc(doc(db, "rooms", room.id), { currentTurn: nextTurn });
    }
  }

  async function advanceStreet(updatedPlayers) {
    const nextStreet = (room.street || 0) + 1;
    if (nextStreet >= 3) {
      await finishRound(updatedPlayers);
      return;
    }
    await updateDoc(doc(db, "rooms", room.id), {
      street: nextStreet,
      currentTurn: room.smallBlindId,
      bettingStart: room.smallBlindId
    });
  }

  async function finishRound(currentPlayers = players) {
    const contenders = currentPlayers.filter((player) => !player.folded && player.answered);
    const pot = currentPlayers.reduce((sum, player) => sum + Number(player.committed || 0), 0);
    const bestDistance = contenders.length ? Math.min(...contenders.map((player) => Math.abs(Number(player.answer) - currentQuestion.answer))) : 0;
    const winners = contenders.filter((player) => Math.abs(Number(player.answer) - currentQuestion.answer) === bestDistance);
    const share = winners.length ? Math.floor(pot / winners.length) : 0;

    await Promise.all(
      winners.map((winner) =>
        updateDoc(doc(db, "rooms", room.id, "players", winner.id), {
          coins: Number(winner.coins || 0) + share
        })
      )
    );

    await updateDoc(doc(db, "rooms", room.id), {
      phase: "result",
      result: {
        answer: currentQuestion.answer,
        pot,
        winners: winners.map((winner) => winner.name),
        unit: currentQuestion.unit
      }
    });
  }

  async function nextRound() {
    const ordered = players.slice().sort((a, b) => a.seat - b.seat);
    const nextRoundNumber = (room.roundNumber || 1) + 1;
    const smallIndex = ((room.smallBlindSeat || 0) + 1) % ordered.length;
    const bigIndex = (smallIndex + 1) % ordered.length;
    const nextBlinds = getBlinds(nextRoundNumber);
    const small = ordered[smallIndex];
    const big = ordered[bigIndex];

    await Promise.all(
      ordered.map((player) =>
        updateDoc(doc(db, "rooms", room.id, "players", player.id), {
          committed: 0,
          folded: false,
          answered: false,
          answer: null
        })
      )
    );
    await updateDoc(doc(db, "rooms", room.id, "players", small.id), {
      committed: Math.min(small.coins, nextBlinds.smallBlind),
      coins: Math.max(0, small.coins - nextBlinds.smallBlind)
    });
    await updateDoc(doc(db, "rooms", room.id, "players", big.id), {
      committed: Math.min(big.coins, nextBlinds.bigBlind),
      coins: Math.max(0, big.coins - nextBlinds.bigBlind)
    });
    await updateDoc(doc(db, "rooms", room.id), {
      phase: "answer",
      roundNumber: nextRoundNumber,
      questionIndex: nextRoundNumber - 1,
      street: 0,
      smallBlindSeat: smallIndex,
      smallBlindId: small.id,
      bigBlindId: big.id,
      currentTurn: ordered[(bigIndex + 1) % ordered.length].id,
      bettingStart: ordered[(bigIndex + 1) % ordered.length].id,
      result: null
    });
  }

  async function openBetting() {
    if (!players.every((player) => player.answered || player.folded)) return;
    await updateDoc(doc(db, "rooms", room.id), {
      phase: "betting"
    });
  }

  if (!me) return null;

  return (
    <main className="shell gameShell">
      <Logo />
      <section className="statusBar">
        <span>Runde {room.roundNumber}</span>
        <span>Small {blinds.smallBlind}</span>
        <span>Big {blinds.bigBlind}</span>
        <span>Pot {players.reduce((sum, player) => sum + Number(player.committed || 0), 0)}</span>
      </section>

      <PlayerTable players={players} currentTurn={room.currentTurn} />

      <section className="panel questionPanel">
        <p className="kicker">Frage</p>
        <h2>{currentQuestion.text}</h2>

        {room.phase === "answer" && (
          <div className="answerBox">
            {me.answered ? (
              <p className="locked">Deine Antwort ist gespeichert: {me.answer}</p>
            ) : (
              <>
                <input value={answerInput} onChange={(event) => setAnswerInput(event.target.value)} placeholder={`Antwort in ${currentQuestion.unit}`} />
                <button className="primary" onClick={submitAnswer}>
                  <Send size={18} />
                  Antwort bestätigen
                </button>
              </>
            )}
            {isHost && (
              <button className="secondary" onClick={openBetting}>
                <Play size={18} />
                Setzrunde öffnen
              </button>
            )}
          </div>
        )}

        {room.phase === "betting" && (
          <>
            <div className="tips">
              {room.street >= 1 && <p><Eye size={16} /> Tipp 1: {currentQuestion.tips[0]}</p>}
              {room.street >= 2 && <p><Eye size={16} /> Tipp 2: {currentQuestion.tips[1]}</p>}
            </div>
            <div className="actions">
              <button className="ghost" disabled={!isMyTurn} onClick={() => act("fold")}>Fold</button>
              <button className="secondary" disabled={!isMyTurn || (me.committed || 0) < currentBet} onClick={() => act("check", me.committed)}>Check</button>
              <button className="secondary" disabled={!isMyTurn} onClick={() => act("call", currentBet)}>Call {Math.max(0, currentBet - (me.committed || 0))}</button>
              <input value={raiseInput} onChange={(event) => setRaiseInput(event.target.value)} placeholder={`mind. ${currentBet + blinds.bigBlind}`} />
              <button className="primary" disabled={!isMyTurn} onClick={() => act("raise", Math.max(currentBet + blinds.bigBlind, Number(raiseInput)))}>
                Raise
              </button>
            </div>
            <p className="soft">{isMyTurn ? "Du bist dran." : "Warten auf den nächsten Spieler."}</p>
          </>
        )}

        {room.phase === "result" && (
          <div className="result">
            <Trophy size={28} />
            <h2>{winnerText}</h2>
            <p>Richtige Antwort: {room.result.answer} {room.result.unit}</p>
            {isHost && (
              <button className="primary" onClick={nextRound}>
                <Play size={18} />
                Nächste Runde
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

export default function App() {
  const [userId, setUserId] = useState(localStorage.getItem("ttocUserId"));
  const [roomCode, setRoomCode] = useState(() => {
    const joinMatch = window.location.pathname.match(/\/join\/([^/]+)/);
    return joinMatch?.[1]?.toUpperCase() || localStorage.getItem("ttocRoomCode") || "";
  });
  const [screen, setScreen] = useState(() => (window.location.pathname.startsWith("/join/") ? "join" : "home"));
  const { room, players, loading } = useRoom(roomCode);

  async function createRoom(roomName) {
    const user = await ensureAnonymousUser();
    const code = makeRoomCode();
    await setDoc(doc(db, "rooms", code), {
      name: roomName?.trim() || "Two Tipps One Cup Raum",
      hostId: user.uid,
      phase: "lobby",
      roundNumber: 1,
      questionIndex: 0,
      street: 0,
      createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "rooms", code, "meta", "counter"), { nextSeat: 1 });
    await setDoc(doc(db, "rooms", code, "players", user.uid), {
      name: "Host",
      coins: STARTING_COINS,
      committed: 0,
      folded: false,
      answered: false,
      answer: null,
      seat: 0,
      role: "host",
      joinedAt: serverTimestamp()
    });
    setUserId(user.uid);
    setRoomCode(code);
    localStorage.setItem("ttocUserId", user.uid);
    localStorage.setItem("ttocRoomCode", code);
    setScreen("invite");
  }

  async function startGame() {
    const ordered = players.slice().sort((a, b) => a.seat - b.seat);
    if (ordered.length < 2) return;
    const small = ordered[0];
    const big = ordered[1];
    const blinds = getBlinds(1);

    await updateDoc(doc(db, "rooms", room.id, "players", small.id), {
      committed: Math.min(small.coins, blinds.smallBlind),
      coins: Math.max(0, small.coins - blinds.smallBlind)
    });
    await updateDoc(doc(db, "rooms", room.id, "players", big.id), {
      committed: Math.min(big.coins, blinds.bigBlind),
      coins: Math.max(0, big.coins - blinds.bigBlind)
    });
    await updateDoc(doc(db, "rooms", room.id), {
      phase: "answer",
      smallBlindSeat: 0,
      smallBlindId: small.id,
      bigBlindId: big.id,
      currentTurn: ordered[2 % ordered.length].id,
      bettingStart: ordered[2 % ordered.length].id
    });
  }

  function joined(code, uid) {
    setUserId(uid);
    setRoomCode(code);
    localStorage.setItem("ttocUserId", uid);
    localStorage.setItem("ttocRoomCode", code);
    setScreen("room");
  }

  if (screen === "home") {
    return <Home onHost={createRoom} onJoin={(code) => { setRoomCode(code); setScreen("join"); }} />;
  }

  if (screen === "invite") {
    return <Invite roomCode={roomCode} roomName={room?.name} onContinue={() => setScreen("room")} />;
  }

  if (screen === "join" || !userId) {
    return <Join roomCode={roomCode} onJoined={joined} />;
  }

  if (loading) {
    return <main className="shell"><Logo /><section className="panel"><h2>Lade Raum...</h2></section></main>;
  }

  if (!room) {
    return <main className="shell"><Logo /><section className="panel"><h2>Raum nicht gefunden</h2><button className="primary" onClick={() => setScreen("home")}>Zur Startseite</button></section></main>;
  }

  if (room.phase === "lobby") {
    return <Lobby room={room} players={players} isHost={room.hostId === userId} onStart={startGame} />;
  }

  return <Game room={room} players={players} userId={userId} />;
}
