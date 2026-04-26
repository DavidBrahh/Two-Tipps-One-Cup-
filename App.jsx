import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
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
  Eye,
  LogIn,
  MessageCircle,
  Play,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserRound,
  Users,
  Wallet
} from "lucide-react";
import { db, ensureAnonymousUser } from "./firebase.js";
import { QUESTIONS as QUESTION_BANK } from "./questions.js";
import logoUrl from "./logo.png";

const STARTING_COINS = 1000;
const BASE_SMALL_BLIND = 25;
const BASE_BIG_BLIND = 50;
const STEP = 25;
const MAX_RAISES_PER_STREET = 2;

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function makePlayerId(authUid) {
  return `${authUid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function shuffleQuestionOrder(excluded = []) {
  const blocked = new Set(excluded);
  const pool = QUESTION_BANK.map((_, index) => index).filter((index) => !blocked.has(index));
  return pool.sort(() => Math.random() - 0.5);
}

function getBlindLevel(roundNumber, playerCount = 2) {
  const roundsPerLevel = Math.max(1, playerCount * 2);
  return Math.floor(Math.max(0, roundNumber - 1) / roundsPerLevel);
}

function getBlinds(roundNumber, playerCount = 2) {
  const multiplier = 2 ** getBlindLevel(roundNumber, playerCount);
  return {
    smallBlind: BASE_SMALL_BLIND * multiplier,
    bigBlind: BASE_BIG_BLIND * multiplier
  };
}

function getCurrentQuestion(room) {
  const order = Array.isArray(room.questionOrder) ? room.questionOrder : [];
  const fallbackIndex = room.questionIndex || 0;
  const index = order[fallbackIndex] ?? fallbackIndex;
  return QUESTION_BANK[index % QUESTION_BANK.length];
}

function getQuestionNumber(room) {
  return Number(room.questionIndex || 0) + 1;
}

function isHostUser(room, userId, me) {
  return Boolean(room?.hostId && (room.hostId === userId || me?.role === "host-player"));
}

function playerName(players, id, fallback = "Spieler") {
  return players.find((player) => player.id === id)?.name || fallback;
}

function normalizeMoney(value) {
  return Math.max(0, Math.round(Number(value || 0) / STEP) * STEP);
}

function formatNumber(value) {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 4 }).format(Number(value || 0));
}

function answerUnit(question) {
  return question.unit ? ` in ${question.unit}` : "";
}

function userMessage(error, fallback) {
  if (!error) return fallback;
  if (error.code === "permission-denied") return "Firebase blockiert die Aktion. Prüfe bitte die Firestore-Regeln.";
  if (error.code?.startsWith("auth/")) return "Die Anmeldung ist gerade blockiert. Prüfe Anonymous Auth und die Vercel-Variablen.";
  return fallback;
}

function livePlayers(players) {
  return players.filter((player) => !player.eliminated);
}

function activePlayers(players) {
  return players.filter((player) => !player.eliminated && !player.folded);
}

function actors(players) {
  return players.filter((player) => !player.eliminated && !player.folded && Number(player.coins || 0) > 0);
}

function nextTurnFrom(list, afterId) {
  const eligible = actors(list);
  if (!eligible.length) return null;
  const index = eligible.findIndex((player) => player.id === afterId);
  return eligible[(index + 1 + eligible.length) % eligible.length]?.id || eligible[0].id;
}

function shouldEndStreet(list, acted = {}) {
  const remaining = activePlayers(list);
  if (remaining.length <= 1) return true;
  const maxCommitted = Math.max(0, ...remaining.map((player) => Number(player.committed || 0)));
  return remaining.every((player) => {
    if (Number(player.coins || 0) <= 0) return true;
    return Boolean(acted[player.id]) && Number(player.committed || 0) >= maxCommitted;
  });
}

function phaseLabel(room) {
  if (room.phase === "answer") return "Antwortphase";
  if (room.phase === "betting" && (room.street || 0) === 0) return "Erste Setzphase";
  if (room.phase === "betting" && room.street === 1) return "Setzphase nach Tipp 1";
  if (room.phase === "betting" && room.street === 2) return "Letzte Setzphase";
  if (room.phase === "result") return "Rundenauswertung";
  if (room.phase === "gameOver") return "Spielende";
  return "Warteraum";
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
      <img className="brandLogo" src={logoUrl} alt="TRY's Logo" />
      <div>
        <p className="kicker">Spielmaster</p>
        <h1>Two Tipps One Cup</h1>
      </div>
    </div>
  );
}

function Home({ onHost, onJoin }) {
  const [roomName, setRoomName] = useState("");
  const [hostName, setHostName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createHostRoom() {
    setError("");
    if (!hostName.trim()) {
      setError("Bitte gib deinen Namen ein.");
      return;
    }

    setBusy(true);
    try {
      await onHost(roomName, hostName);
    } catch (err) {
      console.error(err);
      setError(userMessage(err, "Raum konnte nicht erstellt werden."));
    } finally {
      setBusy(false);
    }
  }

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
            <label>
              Dein Name
              <input value={hostName} onChange={(event) => setHostName(event.target.value)} placeholder="z. B. David" />
            </label>
            {error && <p className="notice error">{error}</p>}
            <button className="primary" disabled={busy} onClick={createHostRoom}>
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
            <p className="miniInfo">{QUESTION_BANK.length} Schatzfragen geladen</p>
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
          <a className="ghost" href={`/join/${roomCode}?host=1`} target="_blank" rel="noreferrer">
            <UserRound size={18} />
            Als Spieler beitreten
          </a>
        </div>
      </section>
    </main>
  );
}

function Join({ roomCode, onJoined }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isHostJoin = new URLSearchParams(window.location.search).get("host") === "1";

  async function joinRoom() {
    if (!name.trim()) return;
    setError("");
    setBusy(true);
    try {
      const user = await ensureAnonymousUser();
      const roomRef = doc(db, "rooms", roomCode);
      const roomSnap = await getDoc(roomRef);
      if (!roomSnap.exists()) {
        setError("Diesen Raum gibt es nicht.");
        setBusy(false);
        return;
      }

      const playersSnap = await getDoc(doc(db, "rooms", roomCode, "meta", "counter"));
      const nextSeat = playersSnap.exists() ? Number(playersSnap.data().nextSeat || 0) : 0;
      const roomData = roomSnap.data();
      const playerId = makePlayerId(user.uid);
      await setDoc(doc(db, "rooms", roomCode, "players", playerId), {
        name: name.trim(),
        coins: STARTING_COINS,
        committed: 0,
        folded: false,
        eliminated: false,
        placement: null,
        wantsRematch: false,
        answered: false,
        answer: null,
        seat: nextSeat,
        authUid: user.uid,
        role: isHostJoin && roomData.hostId === user.uid ? "host-player" : "player",
        joinedAt: serverTimestamp()
      });
      await setDoc(doc(db, "rooms", roomCode, "meta", "counter"), { nextSeat: nextSeat + 1 }, { merge: true });
      onJoined(roomCode, playerId);
    } catch (err) {
      console.error(err);
      setError(userMessage(err, "Beitritt hat nicht geklappt."));
    } finally {
      setBusy(false);
    }
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
        {error && <p className="notice error">{error}</p>}
        <button className="primary" disabled={busy} onClick={joinRoom}>
          <Send size={18} />
          Spiel beitreten
        </button>
      </section>
    </main>
  );
}

function LobbyV2({ room, players, isHost, onStart }) {
  const joinUrl = `${window.location.origin}/join/${room.id}`;
  const canStart = players.length >= 2;

  return (
    <main className="shell">
      <Logo />
      <section className="lobbyHeader panel">
        <div>
          <p className="kicker">Warteraum</p>
          <h2>{room.name}</h2>
          <p className="soft">Teile den Code oder Link. Ab zwei Spielern kann der Host starten.</p>
        </div>
        <div className="roomShare">
          <div className="roomCode small">{room.id}</div>
          <button className="secondary" onClick={() => navigator.clipboard.writeText(joinUrl)}>
            <Clipboard size={18} />
            Link kopieren
          </button>
        </div>
      </section>

      <section className="layout">
        <div className="panel">
          <div className="panelTitle">
            <h2>Spieler</h2>
            <span>{players.length} am Tisch</span>
          </div>
          <div className="lobbySeats">
            {players.map((player) => (
              <div className="lobbySeat" key={player.id}>
                <UserRound size={20} />
                <span>{player.name}</span>
                {player.role === "host-player" && <em>Host</em>}
                {player.role !== "host-player" && <em className="playerBadge">Spieler</em>}
                <strong>{player.coins} Coins</strong>
              </div>
            ))}
          </div>
          {isHost && (
            <button className="primary wideButton" disabled={!canStart} onClick={onStart}>
              <Play size={18} />
              {canStart ? "Spiel starten" : "Mindestens 2 Spieler"}
            </button>
          )}
        </div>
        <div className="panel rules">
          <h2>Kurzregeln</h2>
          <p>Jeder Spieler startet mit 1000 Coins. Small Blind beginnt bei 25 Coins, Big Blind bei 50 Coins.</p>
          <p>Nach zwei kompletten Tischrunden verdoppeln sich die Blinds.</p>
          <p>Antworten, setzen, Tipp 1, setzen, Tipp 2, letzte Setzphase, Auswertung.</p>
          <p>Setzen geht nur in 25er-Schritten. Pro Setzphase darf jeder Spieler maximal zweimal erhöhen.</p>
        </div>
      </section>
    </main>
  );
}

function PlayerTable({ players, currentTurn, pot, blinds, roundNumber, smallBlindId, bigBlindId, winnerIds = [] }) {
  const seatedPlayers = players.length ? players : [];

  return (
    <div className="tableScene" aria-label="Spieltisch">
      <div className="feltTable">
        <div className="tableCenter">
          <span>Pot</span>
          <strong>{pot}</strong>
          <small>Runde {roundNumber} · SB {blinds.smallBlind} / BB {blinds.bigBlind}</small>
        </div>
      </div>

      {seatedPlayers.map((player, index) => {
        const angle = -90 + (index * 360) / seatedPlayers.length;
        const radians = (angle * Math.PI) / 180;
        const x = 50 + Math.cos(radians) * 43;
        const y = 50 + Math.sin(radians) * 37;

        return (
          <div
            className={`seat ${player.id === currentTurn ? "active" : ""} ${player.folded || player.eliminated ? "folded" : ""} ${winnerIds.includes(player.id) ? "winnerSeat" : ""}`}
            key={player.id}
            style={{ "--seat-x": `${x}%`, "--seat-y": `${y}%` }}
          >
            {player.id === smallBlindId && <b className="blindChip">SB</b>}
            {player.id === bigBlindId && <b className="blindChip big">BB</b>}
            <span>{player.name}</span>
            <strong>{player.coins} Coins</strong>
            <small>{player.eliminated ? `Platz ${player.placement || "-"}` : `gesetzt: ${player.committed || 0}`}</small>
          </div>
        );
      })}
    </div>
  );
}

function TimedOverlay({ overlay, onClose }) {
  useEffect(() => {
    if (!overlay) return undefined;
    const timeout = window.setTimeout(onClose, overlay.duration || 2500);
    return () => window.clearTimeout(timeout);
  }, [overlay, onClose]);

  if (!overlay) return null;

  return (
    <div className="centerOverlay" onClick={onClose}>
      <div className={`centerCard ${overlay.kind || ""}`} onClick={(event) => event.stopPropagation()}>
        {overlay.kicker && <p className="kicker">{overlay.kicker}</p>}
        <h2>{overlay.title}</h2>
        {overlay.text && <p>{overlay.text}</p>}
        {overlay.sub && <small>{overlay.sub}</small>}
        {overlay.kind === "winner" && <div className="celebrate"><Sparkles size={24} /> ✦ ✦ ✦</div>}
      </div>
    </div>
  );
}

function ResultOverlay({ result, question, onClose }) {
  useEffect(() => {
    if (!result) return undefined;
    const timeout = window.setTimeout(onClose, 15000);
    return () => window.clearTimeout(timeout);
  }, [result, onClose]);

  if (!result) return null;

  return (
    <div className="centerOverlay" onClick={onClose}>
      <div className="centerCard resultTableCard" onClick={(event) => event.stopPropagation()}>
        <p className="kicker">Rundenauswertung</p>
        <h2>{question.text}</h2>
        <p className="answerLine">Richtige Antwort: <strong>{question.answerText || formatNumber(question.answer)}</strong></p>
        <div className="resultTable">
          <div>Spieler</div>
          <div>Antwort</div>
          <div>Abstand</div>
          <div>Status</div>
          {(result.responses || []).map((entry) => (
            <React.Fragment key={entry.playerId}>
              <strong className={entry.won ? "winnerName" : ""}>{entry.name}</strong>
              <span>{entry.folded ? "Fold" : formatNumber(entry.answer)}</span>
              <span>{entry.folded ? "-" : formatNumber(entry.distance)}</span>
              <span>{entry.won ? `Gewinnt ${result.share} Coins` : entry.folded ? "Gefoldet" : "Dabei"}</span>
            </React.Fragment>
          ))}
        </div>
        <button className="ghost wideButton" onClick={onClose}>Schließen</button>
      </div>
    </div>
  );
}

function ActionFeed({ action }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!action?.text) return undefined;
    setVisible(true);
    const timeout = window.setTimeout(() => setVisible(false), 3500);
    return () => window.clearTimeout(timeout);
  }, [action?.at, action?.text]);

  if (!action?.text || !visible) return null;
  return <div className="actionToast">{action.text}</div>;
}

function HostTools({ room, players, onForceStreet, onForceResult, onNextRound, onSaveCoins }) {
  const [open, setOpen] = useState(false);
  const [coins, setCoins] = useState({});

  useEffect(() => {
    setCoins(Object.fromEntries(players.map((player) => [player.id, player.coins || 0])));
  }, [players]);

  return (
    <div className="hostTools">
      <div className="buttonRow">
        <button className="secondary" onClick={() => onForceStreet(1)}>Tipp 1 einblenden</button>
        <button className="secondary" onClick={() => onForceStreet(2)}>Tipp 2 einblenden</button>
        <button className="primary" onClick={onForceResult}>Auswertung der Runde</button>
        {room.phase === "result" && <button className="primary" onClick={onNextRound}>Nächste Runde</button>}
        <button className="ghost" onClick={() => setOpen((value) => !value)}>Manuelle Zuteilung</button>
      </div>
      {open && (
        <div className="coinEditor">
          {players.map((player) => (
            <label key={player.id}>
              {player.name} derzeit {player.coins || 0}
              <input
                type="number"
                value={coins[player.id] ?? 0}
                onChange={(event) => setCoins({ ...coins, [player.id]: Number(event.target.value) })}
              />
            </label>
          ))}
          <button className="primary" onClick={() => onSaveCoins(coins)}>Zuteilung speichern</button>
        </div>
      )}
    </div>
  );
}

function GameOver({ room, players, me, isHost, onRematch, onStartRematch }) {
  const standings = room.standings || players.slice().sort((a, b) => (a.placement || 99) - (b.placement || 99));
  const rematchCount = players.filter((player) => player.wantsRematch).length;

  return (
    <section className="panel result">
      <Trophy size={34} />
      <p className="kicker">Spielende</p>
      <h2>{standings[0]?.name || "Gewinner"} gewinnt das Spiel</h2>
      <div className="standings">
        {standings.map((entry, index) => (
          <div className="standingRow" key={entry.playerId || entry.id}>
            <strong>#{entry.placement || index + 1}</strong>
            <span>{entry.name}</span>
            <em>{entry.coins || 0} Coins</em>
          </div>
        ))}
      </div>
      {me && !me.wantsRematch && (
        <button className="secondary" onClick={onRematch}>
          <RotateCcw size={18} />
          Nochmal spielen
        </button>
      )}
      {me?.wantsRematch && <p className="turnHint">Du bist für die nächste Partie vorgemerkt.</p>}
      {isHost && (
        <button className="primary" disabled={rematchCount < 2} onClick={onStartRematch}>
          <Play size={18} />
          Neues Spiel mit {rematchCount} Spielern starten
        </button>
      )}
    </section>
  );
}

function Game({ room, players, userId }) {
  const [answerInput, setAnswerInput] = useState("");
  const [raiseInput, setRaiseInput] = useState("");
  const [overlay, setOverlay] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [actionError, setActionError] = useState("");
  const [lastOverlayKey, setLastOverlayKey] = useState("");
  const me = players.find((player) => player.id === userId);
  const currentQuestion = getCurrentQuestion(room);
  const isHost = isHostUser(room, userId, me);
  const gamePlayers = livePlayers(players);
  const currentBet = Math.max(0, ...gamePlayers.map((player) => player.committed || 0));
  const isMyTurn = room.currentTurn === userId;
  const blinds = getBlinds(room.roundNumber || 1, Math.max(2, gamePlayers.length || players.length));
  const pot = players.reduce((sum, player) => sum + Number(player.committed || 0), 0);
  const toCall = Math.max(0, currentBet - (me?.committed || 0));
  const minimumRaise = currentBet + blinds.bigBlind;
  const currentTurnName = playerName(players, room.currentTurn, "nächsten Spieler");
  const winnerIds = room.result?.winnerIds || [];
  const raiseCounts = room.raiseCounts || {};
  const myRaises = raiseCounts[userId] || 0;
  const canRaise = isMyTurn && me && myRaises < MAX_RAISES_PER_STREET && Number(me.coins || 0) > toCall;

  const winnerText = useMemo(() => {
    if (!room.result) return "";
    if ((room.result.winners || []).length > 1) return `${room.result.winners.join(", ")} splitten ${room.result.pot} Coins`;
    return room.result.winners?.length ? `${room.result.winners[0]} gewinnt ${room.result.pot} Coins` : "";
  }, [room.result]);

  useEffect(() => {
    if (!isHost || room.phase !== "answer") return;
    const inRound = livePlayers(players);
    if (!inRound.length || !inRound.every((player) => player.answered || player.folded || player.eliminated)) return;
    updateDoc(doc(db, "rooms", room.id), {
      phase: "betting",
      currentTurn: nextTurnFrom(players, room.bigBlindId) || room.smallBlindId || inRound[0]?.id,
      bettingStart: nextTurnFrom(players, room.bigBlindId) || room.smallBlindId || inRound[0]?.id,
      actedThisStreet: {},
      raiseCounts: {},
      actionFeed: { text: "Erste Setzphase startet", at: Date.now() }
    }).catch(console.error);
  }, [isHost, players, room.id, room.phase, room.bigBlindId, room.smallBlindId]);

  useEffect(() => {
    const key = `${room.phase}-${room.street || 0}-${room.currentTurn || ""}-${room.result?.pot || ""}-${room.roundNumber || 0}`;
    if (key === lastOverlayKey) return;
    setLastOverlayKey(key);

    if (room.phase === "betting") {
      if ((room.street || 0) === 1) {
        setOverlay({
          kind: "tip",
          kicker: "Tipp 1",
          title: currentQuestion.tips?.[0] || "Kein Tipp vorhanden",
          text: `${currentTurnName} ist als nächstes dran.`,
          duration: 8000
        });
      } else if (room.street === 2) {
        setOverlay({
          kind: "tip",
          kicker: "Tipp 2",
          title: currentQuestion.tips?.[1] || "Kein Tipp vorhanden",
          text: "Letzte Setzphase",
          sub: `${currentTurnName} ist als nächstes dran.`,
          duration: 8000
        });
      } else if (room.currentTurn) {
        setOverlay({
          kind: "turn",
          kicker: "Setzphase",
          title: `${currentTurnName} ist dran`,
          duration: 1800
        });
      }
    }

    if (room.phase === "result" && room.result) {
      setOverlay({
        kind: "winner",
        kicker: "Rundensieger",
        title: winnerText,
        text: `Antwort: ${room.result.winnerAnswers?.join(", ") || "-"}`,
        duration: 2200
      });
      const timeout = window.setTimeout(() => setShowResult(true), 2200);
      return () => window.clearTimeout(timeout);
    }

    if (room.blindNotice) {
      setOverlay({
        kind: "blind",
        kicker: "Blinds angepasst",
        title: `SB ${room.blindNotice.smallBlind} / BB ${room.blindNotice.bigBlind}`,
        duration: 3000
      });
    }

    return undefined;
  }, [room.phase, room.street, room.currentTurn, room.result, room.blindNotice, room.roundNumber, currentQuestion, currentTurnName, winnerText, lastOverlayKey]);

  async function submitAnswer() {
    const numeric = Number(answerInput.replace(",", "."));
    if (!Number.isFinite(numeric)) {
      setActionError("Bitte gib eine gültige Zahl ein.");
      return;
    }
    await updateDoc(doc(db, "rooms", room.id, "players", userId), {
      answer: numeric,
      answered: true
    });
    setAnswerInput("");
    setActionError("");
  }

  async function handlePostAction(updatedPlayers, actedThisStreet) {
    const remaining = activePlayers(updatedPlayers);
    if (remaining.length <= 1) {
      await finishRound(updatedPlayers);
      return;
    }

    if (actors(updatedPlayers).length <= 1 && remaining.every((player) => Number(player.coins || 0) <= 0 || Number(player.committed || 0) >= currentBet)) {
      await finishRound(updatedPlayers);
      return;
    }

    if (shouldEndStreet(updatedPlayers, actedThisStreet)) {
      await advanceStreet(updatedPlayers);
      return;
    }

    const nextTurn = nextTurnFrom(updatedPlayers, userId);
    await updateDoc(doc(db, "rooms", room.id), { currentTurn: nextTurn });
  }

  async function act(type, amount = 0) {
    if (!me || !isMyTurn || me.eliminated) return;
    const playerRef = doc(db, "rooms", room.id, "players", userId);
    const updates = {};
    let actedThisStreet = { ...(room.actedThisStreet || {}), [userId]: true };
    const nextRaiseCounts = { ...(room.raiseCounts || {}) };
    let actionText = "";

    if (type === "fold") {
      updates.folded = true;
      actionText = `${me.name} foldet`;
    } else if (type === "check") {
      if (toCall > 0) return;
      actionText = `${me.name} checkt`;
    } else if (type === "call") {
      const pay = Math.max(0, Math.min(me.coins, toCall));
      updates.committed = (me.committed || 0) + pay;
      updates.coins = me.coins - pay;
      actionText = `${me.name} geht mit ${pay} mit`;
    } else if (type === "raise") {
      const target = normalizeMoney(amount);
      if (myRaises >= MAX_RAISES_PER_STREET) {
        setActionError("Du hast in dieser Setzphase bereits 2x erhöht.");
        return;
      }
      if (target < minimumRaise) {
        setActionError(`Erhöhung muss mindestens auf ${minimumRaise} Coins gesetzt werden.`);
        return;
      }
      if (target > (me.committed || 0) + me.coins) {
        setActionError("Du hast nicht genug Coins für diese Erhöhung.");
        return;
      }
      const pay = Math.max(0, Math.min(me.coins, target - (me.committed || 0)));
      updates.committed = (me.committed || 0) + pay;
      updates.coins = me.coins - pay;
      nextRaiseCounts[userId] = myRaises + 1;
      actedThisStreet = { [userId]: true };
      actionText = `${me.name} erhöht auf ${updates.committed}`;
      setRaiseInput("");
    }

    await updateDoc(playerRef, updates);
    setActionError("");
    const updatedPlayers = players.map((player) => (player.id === userId ? { ...player, ...updates } : player));
    await updateDoc(doc(db, "rooms", room.id), {
      actedThisStreet,
      raiseCounts: nextRaiseCounts,
      bettingStart: type === "raise" ? userId : room.bettingStart,
      actionFeed: { text: actionText, at: Date.now() }
    });
    await handlePostAction(updatedPlayers, actedThisStreet);
  }

  async function advanceStreet(updatedPlayers) {
    if (actors(updatedPlayers).length <= 1) {
      await finishRound(updatedPlayers);
      return;
    }

    const nextStreet = (room.street || 0) + 1;
    if (nextStreet >= 3) {
      await finishRound(updatedPlayers);
      return;
    }
    const nextStarter = nextTurnFrom(updatedPlayers, room.smallBlindId) || actors(updatedPlayers)[0]?.id || null;
    await updateDoc(doc(db, "rooms", room.id), {
      street: nextStreet,
      currentTurn: nextStarter,
      bettingStart: nextStarter,
      actedThisStreet: {},
      raiseCounts: {},
      actionFeed: { text: nextStreet === 2 ? "Letzte Setzphase startet" : "Nächste Setzphase startet", at: Date.now() }
    });
  }

  async function finishRound(currentPlayers = players) {
    const contenders = currentPlayers.filter((player) => !player.eliminated && !player.folded && player.answered);
    const roundPot = currentPlayers.reduce((sum, player) => sum + Number(player.committed || 0), 0);
    const bestDistance = contenders.length ? Math.min(...contenders.map((player) => Math.abs(Number(player.answer) - currentQuestion.answer))) : 0;
    const winners = contenders.filter((player) => Math.abs(Number(player.answer) - currentQuestion.answer) === bestDistance);
    const share = winners.length ? Math.floor(roundPot / winners.length) : 0;
    const winnerIdsNext = winners.map((winner) => winner.id);
    const responses = currentPlayers.map((player) => {
      const answer = Number(player.answer);
      const folded = Boolean(player.folded || player.eliminated);
      return {
        playerId: player.id,
        name: player.name,
        answer: player.answer,
        distance: folded || !Number.isFinite(answer) ? null : Math.abs(answer - currentQuestion.answer),
        folded,
        won: winnerIdsNext.includes(player.id)
      };
    });

    await Promise.all(
      winners.map((winner) =>
        updateDoc(doc(db, "rooms", room.id, "players", winner.id), {
          coins: Number(winner.coins || 0) + share
        })
      )
    );

    const afterPayout = currentPlayers.map((player) =>
      winnerIdsNext.includes(player.id) ? { ...player, coins: Number(player.coins || 0) + share } : player
    );
    const stillAlive = afterPayout.filter((player) => !player.eliminated && Number(player.coins || 0) > 0);
    const newlyEliminated = afterPayout.filter((player) => !player.eliminated && Number(player.coins || 0) <= 0);
    const placements = {};
    newlyEliminated.forEach((player, index) => {
      placements[player.id] = stillAlive.length + newlyEliminated.length - index;
    });

    await Promise.all(
      newlyEliminated.map((player) =>
        updateDoc(doc(db, "rooms", room.id, "players", player.id), {
          eliminated: true,
          placement: placements[player.id]
        })
      )
    );

    const gameOver = stillAlive.length <= 1 && livePlayers(afterPayout).length > 1;
    const standings = gameOver
      ? afterPayout
          .map((player) => ({
            playerId: player.id,
            name: player.name,
            coins: Number(player.coins || 0),
            placement: stillAlive[0]?.id === player.id ? 1 : placements[player.id] || player.placement || 2
          }))
          .sort((a, b) => a.placement - b.placement)
      : null;

    await updateDoc(doc(db, "rooms", room.id), {
      phase: gameOver ? "gameOver" : "result",
      result: {
        answer: currentQuestion.answer,
        answerText: currentQuestion.answerText || "",
        pot: roundPot,
        share,
        winners: winners.map((winner) => winner.name),
        winnerIds: winnerIdsNext,
        winnerAnswers: winners.map((winner) => formatNumber(winner.answer)),
        responses,
        unit: currentQuestion.unit || ""
      },
      standings,
      currentTurn: null,
      actionFeed: { text: winners.length > 1 ? "Der Pot wird gesplittet" : `${winners[0]?.name || "Niemand"} gewinnt die Runde`, at: Date.now() }
    });
  }

  async function nextRound() {
    const ordered = players.filter((player) => !player.eliminated && Number(player.coins || 0) > 0).slice().sort((a, b) => a.seat - b.seat);
    if (ordered.length < 2) {
      await finishRound(players);
      return;
    }
    const nextRoundNumber = (room.roundNumber || 1) + 1;
    const smallIndex = ((room.smallBlindSeat || 0) + 1) % ordered.length;
    const bigIndex = (smallIndex + 1) % ordered.length;
    const previousBlinds = getBlinds(room.roundNumber || 1, Math.max(2, ordered.length));
    const nextBlinds = getBlinds(nextRoundNumber, Math.max(2, ordered.length));
    const small = ordered[smallIndex];
    const big = ordered[bigIndex];
    const used = Array.isArray(room.usedQuestionIds) ? room.usedQuestionIds : [];
    let questionOrder = Array.isArray(room.questionOrder) ? room.questionOrder : [];
    let nextQuestionIndex = (room.questionIndex || 0) + 1;

    if (questionOrder[nextQuestionIndex] === undefined) {
      questionOrder = [...questionOrder, ...shuffleQuestionOrder(used)];
    }

    await Promise.all(
      players.map((player) =>
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
      questionIndex: nextQuestionIndex,
      questionOrder,
      usedQuestionIds: [...used, questionOrder[nextQuestionIndex]].filter((value) => value !== undefined),
      street: 0,
      smallBlindSeat: smallIndex,
      smallBlindId: small.id,
      bigBlindId: big.id,
      currentTurn: ordered[(bigIndex + 1) % ordered.length].id,
      bettingStart: ordered[(bigIndex + 1) % ordered.length].id,
      actedThisStreet: {},
      raiseCounts: {},
      result: null,
      blindNotice: previousBlinds.bigBlind !== nextBlinds.bigBlind ? nextBlinds : null
    });
    setShowResult(false);
  }

  async function openBetting() {
    if (!livePlayers(players).every((player) => player.answered || player.folded)) return;
    const first = nextTurnFrom(players, room.bigBlindId) || room.smallBlindId;
    await updateDoc(doc(db, "rooms", room.id), {
      phase: "betting",
      currentTurn: first,
      bettingStart: first,
      actedThisStreet: {},
      raiseCounts: {}
    });
  }

  async function forceStreet(street) {
    const first = nextTurnFrom(players, room.smallBlindId) || actors(players)[0]?.id || null;
    await updateDoc(doc(db, "rooms", room.id), {
      phase: "betting",
      street,
      currentTurn: first,
      bettingStart: first,
      actedThisStreet: {},
      raiseCounts: {},
      actionFeed: { text: street === 2 ? "Tipp 2 wurde eingeblendet" : "Tipp 1 wurde eingeblendet", at: Date.now() }
    });
  }

  async function saveCoins(coins) {
    await Promise.all(
      Object.entries(coins).map(([playerId, value]) =>
        updateDoc(doc(db, "rooms", room.id, "players", playerId), {
          coins: normalizeMoney(value),
          eliminated: false,
          placement: null
        })
      )
    );
  }

  async function markRematch() {
    if (!me) return;
    await updateDoc(doc(db, "rooms", room.id, "players", me.id), { wantsRematch: true });
  }

  async function startRematch() {
    const rematchPlayers = players.filter((player) => player.wantsRematch);
    if (rematchPlayers.length < 2) return;
    const used = Array.isArray(room.usedQuestionIds) ? room.usedQuestionIds : [];
    const questionOrder = shuffleQuestionOrder(used);
    await Promise.all(
      players.map((player) =>
        updateDoc(doc(db, "rooms", room.id, "players", player.id), {
          coins: player.wantsRematch ? STARTING_COINS : 0,
          committed: 0,
          folded: false,
          eliminated: !player.wantsRematch,
          placement: null,
          wantsRematch: false,
          answered: false,
          answer: null
        })
      )
    );
    await updateDoc(doc(db, "rooms", room.id), {
      phase: "lobby",
      roundNumber: 1,
      questionIndex: 0,
      questionOrder,
      usedQuestionIds: [...used, questionOrder[0]].filter((value) => value !== undefined),
      street: 0,
      result: null,
      standings: null,
      gameNumber: Number(room.gameNumber || 1) + 1
    });
  }

  const commonTable = (
    <PlayerTable
      players={players}
      currentTurn={room.currentTurn}
      pot={pot}
      blinds={blinds}
      roundNumber={room.roundNumber}
      smallBlindId={room.smallBlindId}
      bigBlindId={room.bigBlindId}
      winnerIds={winnerIds}
    />
  );

  if (!me && isHost) {
    return (
      <main className="shell gameShell">
        <Logo />
        <section className="statusBar">
          <span><ShieldCheck size={16} /> Runde {room.roundNumber}</span>
          <span>Frage {getQuestionNumber(room)}</span>
          <span>Small {blinds.smallBlind}</span>
          <span>Big {blinds.bigBlind}</span>
          <span><Wallet size={16} /> Pot {pot}</span>
          <span>Host-Ansicht</span>
        </section>
        {commonTable}
        <section className="panel questionPanel">
          <p className="kicker">{phaseLabel(room)}</p>
          <h2>{currentQuestion.text}</h2>
          {room.phase === "answer" && <p className="turnHint">Warten, bis alle Spieler ihre Antwort bestätigt haben.</p>}
          {room.phase === "betting" && <p className="turnHint">Spieler setzen gerade. Warten auf {currentTurnName}.</p>}
          {room.phase === "result" && (
            <div className="result">
              <Trophy size={28} />
              <h2>{winnerText}</h2>
              <p>Richtige Antwort: {currentQuestion.answerText || `${formatNumber(room.result.answer)} ${room.result.unit || ""}`}</p>
              <button className="secondary" onClick={() => setShowResult(true)}>Antworttabelle anzeigen</button>
              <button className="primary" onClick={nextRound}><Play size={18} />Nächste Runde</button>
            </div>
          )}
          <HostTools room={room} players={players} onForceStreet={forceStreet} onForceResult={() => finishRound(players)} onNextRound={nextRound} onSaveCoins={saveCoins} />
        </section>
        <TimedOverlay overlay={overlay} onClose={() => setOverlay(null)} />
        {showResult && <ResultOverlay result={room.result} question={currentQuestion} onClose={() => setShowResult(false)} />}
        <ActionFeed action={room.actionFeed} />
      </main>
    );
  }

  if (!me) return null;

  return (
    <main className="shell gameShell">
      <Logo />
      <section className="statusBar">
        <span><ShieldCheck size={16} /> Runde {room.roundNumber}</span>
        <span>Frage {getQuestionNumber(room)}</span>
        <span>Small {blinds.smallBlind}</span>
        <span>Big {blinds.bigBlind}</span>
        <span><Wallet size={16} /> Pot {pot}</span>
        <span>{room.phase === "betting" ? `Dran: ${currentTurnName}` : me.name}</span>
      </section>

      {commonTable}

      <section className="panel questionPanel">
        <p className="kicker">{room.phase === "answer" ? `Frage ${getQuestionNumber(room)}` : phaseLabel(room)}</p>
        <h2>{currentQuestion.text}</h2>

        {room.phase === "answer" && !me.eliminated && (
          <div className="answerBox">
            {me.answered ? (
              <p className="locked">Deine Antwort ist gespeichert: {formatNumber(me.answer)}</p>
            ) : (
              <>
                <input value={answerInput} onChange={(event) => setAnswerInput(event.target.value)} placeholder={`Antwort${answerUnit(currentQuestion)}`} />
                <button className="primary" onClick={submitAnswer}><Send size={18} />Antwort bestaetigen</button>
              </>
            )}
            {isHost && <button className="secondary" onClick={openBetting}><Play size={18} />Setzrunde öffnen</button>}
          </div>
        )}
        {me.eliminated && room.phase !== "gameOver" && (
          <div className="answerBox">
            <p className="locked">Du schaust weiter zu. Platzierung: {me.placement || "offen"}</p>
            {!me.wantsRematch && <button className="secondary" onClick={markRematch}>Nochmal spielen</button>}
          </div>
        )}
        {actionError && <p className="notice error">{actionError}</p>}

        {room.phase === "betting" && !me.eliminated && (
          <>
            <div className="tips">
              {room.street >= 1 && <p><Eye size={16} /> Tipp 1: {currentQuestion.tips[0]}</p>}
              {room.street >= 2 && <p><Eye size={16} /> Tipp 2: {currentQuestion.tips[1]}</p>}
            </div>
            <div className="actions">
              <button className="ghost" disabled={!isMyTurn} onClick={() => act("fold")}>Fold</button>
              <button className="secondary" disabled={!isMyTurn || toCall > 0} onClick={() => act("check")}>Check</button>
              <button className="secondary" disabled={!isMyTurn || toCall === 0} onClick={() => act("call")}>Mitgehen {toCall}</button>
              <input value={raiseInput} onChange={(event) => setRaiseInput(event.target.value)} placeholder={`Erhöhen auf mind. ${minimumRaise}`} />
              <button className="primary" disabled={!canRaise} onClick={() => act("raise", Number(raiseInput))}>Erhöhen</button>
            </div>
            <p className="turnHint">
              {isMyTurn ? `Du bist dran. ${toCall > 0 ? `Zum Mitgehen brauchst du ${toCall} Coins.` : "Du kannst checken oder erhöhen."}` : `Warten auf ${currentTurnName}.`}
            </p>
          </>
        )}

        {room.phase === "result" && (
          <div className="result">
            <Trophy size={28} />
            <h2>{winnerText}</h2>
            <p>Richtige Antwort: {currentQuestion.answerText || `${formatNumber(room.result.answer)} ${room.result.unit || ""}`}</p>
            <button className="secondary" onClick={() => setShowResult(true)}>Antworttabelle anzeigen</button>
            {isHost && <button className="primary" onClick={nextRound}><Play size={18} />Nächste Runde</button>}
          </div>
        )}

        {room.phase === "gameOver" && <GameOver room={room} players={players} me={me} isHost={isHost} onRematch={markRematch} onStartRematch={startRematch} />}

        {isHost && <HostTools room={room} players={players} onForceStreet={forceStreet} onForceResult={() => finishRound(players)} onNextRound={nextRound} onSaveCoins={saveCoins} />}
      </section>
      <TimedOverlay overlay={overlay} onClose={() => setOverlay(null)} />
      {showResult && <ResultOverlay result={room.result} question={currentQuestion} onClose={() => setShowResult(false)} />}
      <ActionFeed action={room.actionFeed} />
    </main>
  );
}

export default function App() {
  const [userId, setUserId] = useState(sessionStorage.getItem("ttocPlayerId") || sessionStorage.getItem("ttocControllerId"));
  const [roomCode, setRoomCode] = useState(() => {
    const joinMatch = window.location.pathname.match(/\/join\/([^/]+)/);
    return joinMatch?.[1]?.toUpperCase() || sessionStorage.getItem("ttocRoomCode") || "";
  });
  const [screen, setScreen] = useState(() => (window.location.pathname.startsWith("/join/") ? "join" : "home"));
  const { room, players, loading } = useRoom(roomCode);
  const me = players.find((player) => player.id === userId);
  const isHostController = room?.hostId && userId === room.hostId;

  async function createRoom(roomName, hostName) {
    const user = await ensureAnonymousUser();
    const code = makeRoomCode();
    const questionOrder = shuffleQuestionOrder();
    await setDoc(doc(db, "rooms", code), {
      name: roomName?.trim() || "Two Tipps One Cup Raum",
      hostId: user.uid,
      hostName: hostName?.trim() || "Host",
      phase: "lobby",
      roundNumber: 1,
      questionIndex: 0,
      questionOrder,
      usedQuestionIds: questionOrder[0] !== undefined ? [questionOrder[0]] : [],
      gameNumber: 1,
      street: 0,
      createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "rooms", code, "meta", "counter"), { nextSeat: 0 });
    setUserId(user.uid);
    setRoomCode(code);
    sessionStorage.setItem("ttocControllerId", user.uid);
    sessionStorage.setItem("ttocRoomCode", code);
    setScreen("invite");
  }

  async function startGame() {
    const ordered = players.filter((player) => !player.eliminated).slice().sort((a, b) => a.seat - b.seat);
    if (ordered.length < 2) return;
    const small = ordered[0];
    const big = ordered[1];
    const blinds = getBlinds(1, Math.max(2, ordered.length));

    await Promise.all(
      ordered.map((player) =>
        updateDoc(doc(db, "rooms", room.id, "players", player.id), {
          coins: Number(player.coins ?? STARTING_COINS),
          committed: 0,
          folded: false,
          answered: false,
          answer: null,
          eliminated: false,
          placement: null
        })
      )
    );
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
      bettingStart: ordered[2 % ordered.length].id,
      actedThisStreet: {},
      raiseCounts: {},
      result: null,
      standings: null
    });
  }

  function joined(code, uid) {
    setUserId(uid);
    setRoomCode(code);
    sessionStorage.setItem("ttocPlayerId", uid);
    sessionStorage.setItem("ttocRoomCode", code);
    setScreen("room");
  }

  if (screen === "home") {
    return <Home onHost={createRoom} onJoin={(code) => { setRoomCode(code); setScreen("join"); }} />;
  }

  if (screen === "invite") {
    return <Invite roomCode={roomCode} roomName={room?.name} onContinue={() => setScreen("room")} />;
  }

  if (screen === "join" || (!userId && !isHostController)) {
    return <Join roomCode={roomCode} onJoined={joined} />;
  }

  if (loading) {
    return <main className="shell"><Logo /><section className="panel"><h2>Lade Raum...</h2></section></main>;
  }

  if (!room) {
    return <main className="shell"><Logo /><section className="panel"><h2>Raum nicht gefunden</h2><button className="primary" onClick={() => setScreen("home")}>Zur Startseite</button></section></main>;
  }

  if (room.phase === "lobby") {
    return <LobbyV2 room={room} players={players} isHost={isHostUser(room, userId, me)} onStart={startGame} />;
  }

  return <Game room={room} players={players} userId={userId} />;
}
