import { useSyncExternalStore } from "react";

export type Lang = "ko" | "en";

const STORAGE_KEY = "rsk:lang";

const DICT: Record<Lang, Record<string, string>> = {
  ko: {
    "lang.switch": "언어 선택",

    "app.tagline": "실제 Renaiss 카드로 즐기는 입문 게임",
    "app.dataSourcePrefix": "데이터 ",
    "app.dataSourceSuffix": " · 마켓/팩 공식 ",
    "app.disconnected": "서버와 연결이 끊겼습니다 — 자동 재접속 중…",
    "app.cardPoolMissing": "카드 데이터를 불러올 수 없습니다 — npm run prefetch를 실행하세요",
    "app.roomClosed.hostLeft": "방장이 나가서 방이 사라졌습니다",
    "app.roomClosed.default": "방이 닫혔습니다 ({reason})",
    "app.roomMissing": "방 정보가 없습니다.",
    "app.backToLobby": "← 로비로",
    "app.start": "시작!",
    "app.footer": "가격·등급은 Renaiss OS Index 출처. 비영리 팬 프로토타입.",

    "login.nickname": "게스트 닉네임",
    "login.nicknameHint": "(1~12자)",
    "login.placeholder": "닉네임을 입력하세요",
    "login.connecting": "접속 중…",
    "login.start": "게스트로 시작",
    "login.demoNote": "데모에서는 닉네임만으로 바로 시작합니다. 실서비스에서는 X(트위터) 또는 Web3 지갑으로 Renaiss 계정과 연동됩니다.",

    "lobby.defaultRoomName": "{name}의 방",
    "lobby.soloRoomName": "{name}의 싱글 플레이",
    "lobby.refresh": "새로고침",
    "lobby.createRoom": "방 만들기",
    "lobby.quickStart": "바로 시작",
    "lobby.roomTitle": "방 제목",
    "lobby.map": "맵",
    "lobby.players": "인원",
    "lobby.host": "방장",
    "lobby.loading": "방 목록을 불러오는 중…",
    "lobby.empty": "아직 열린 방이 없어요. 방을 만들거나 바로 시작해 보세요.",
    "lobby.passwordRoom": "비밀번호 방",
    "lobby.inProgress": "진행중",
    "lobby.full": "정원초과",
    "lobby.join": "입장",
    "lobby.myProfile": "내 프로필",
    "lobby.totalPlays": "총 플레이",
    "lobby.wins": "1위 횟수",
    "lobby.dexProgress": "도감 달성",
    "lobby.marketTitleLine1": "진짜 카드를",
    "lobby.marketTitleLine2": "온라인에서 소유하세요",
    "lobby.marketDesc": "PSA 등급 카드를 디지털로 소유하고, 원하면 실물로 받을 수 있습니다.",
    "lobby.marketLink": "마켓 구경하기 →",
    "lobby.dex": "도감",
    "lobby.settings": "설정",
    "lobby.settingsPending": "설정은 준비 중입니다",
    "lobby.roomName": "방 이름",
    "lobby.maxPlayers": "최대 인원",
    "lobby.playerCount": "{count}명",
    "lobby.visibility": "공개 여부",
    "lobby.public": "공개",
    "lobby.private": "비공개",
    "lobby.password": "비밀번호",
    "lobby.passwordPlaceholder": "비워두면 비밀번호 없음",
    "lobby.cards": "카드",
    "lobby.mapNote": "맵 모드·난이도는 방을 만든 뒤 대기실에서 방장이 선택합니다.",
    "lobby.cancel": "취소",
    "lobby.privatePrompt": "비공개 방입니다. 비밀번호를 입력하세요.",

    "map.selectTitle": "{name} — 맵 선택",
    "map.type": "맵 유형",
    "map.difficulty": "난이도",
    "map.all": "전체",
    "map.exclusive": "{game} 전용",
    "map.empty": "조건에 맞는 맵이 없습니다.",
    "map.cancel": "취소",
    "map.confirm": "선택 완료",
    "map.diff.easy": "초급",
    "map.diff.normal": "중급",
    "map.diff.hard": "고급",
    "map.preset.straw-hat": "밀짚모자",
    "map.preset.devil-fruit": "악마의 열매",
    "map.preset.monster-ball": "몬스터볼",
    "map.preset.pikachu": "피카츄",
    "map.preset.charizard": "리자몽",
    "map.preset.jolly-roger": "해적깃발",
    "map.preset.bulbasaur": "이상해씨",
    "map.preset.squirtle": "꼬북이",
    "map.preset.luffy": "루피",
    "map.preset.nami": "나미",
    "map.preset.sudowoodo": "꼬지모",
    "map.preset.mewtwo": "뮤츠",
    "map.preset.chopper": "초파",
    "map.preset.going-merry": "고잉메리호",

    "label.game.pokemon": "포켓몬",
    "label.game.one-piece": "원피스",
    "label.mode.normal": "일반",
    "label.mode.rolling": "롤링",
    "label.mode.up": "UP",
    "label.mode.victory": "승리",
    "label.mode.shanghai": "상하이",
    "label.modeDesc.normal": "기본 매칭 규칙",
    "label.modeDesc.rolling": "4초마다 바깥 테두리가 시계방향으로 회전",
    "label.modeDesc.up": "넓은 보드 · 짝이 막히면(교착) 최하단에서 한 줄 상승",
    "label.modeDesc.victory": "승리 카드 짝을 먼저 맞추면 즉시 1위",
    "label.modeDesc.shanghai": "겹층 — 위층을 걷어야 아래층 선택 가능",
    "label.diff.easy": "쉬움",
    "label.diff.normal": "보통",
    "label.diff.hard": "어려움",
    "label.state.waiting": "대기",
    "label.state.ended": "종료",
    "label.state.playing": "진행중",

    "error.notFound": "방을 찾을 수 없습니다",
    "error.full": "정원이 가득 찼습니다",
    "error.playing": "이미 게임이 진행 중인 방입니다",
    "error.badPassword": "비밀번호가 일치하지 않습니다",
    "error.notHost": "방장만 할 수 있는 작업입니다",
    "error.badNickname": "닉네임은 1~12자로 입력하세요",
    "error.badRequest": "잘못된 요청입니다",
    "error.notInRoom": "방에 입장한 상태가 아닙니다",
    "error.notPlaying": "게임 중이 아닙니다",
    "error.quota": "아이템을 모두 사용했습니다",
    "error.noQuota": "아이템을 모두 사용했습니다",
    "error.noPower": "발동 중인 콤보 효과가 없습니다",
    "error.notComplete": "아직 도감을 완성하지 못했습니다",
    "error.alreadyClaimed": "이미 보상을 받았습니다",
    "error.timeout": "서버 응답이 없습니다 — 서버 실행 여부를 확인하세요",
    "error.generic": "오류가 발생했습니다",
    "error.genericDetail": "오류가 발생했습니다 ({error})",
  },
  en: {
    "lang.switch": "Select language",

    "app.tagline": "A beginner-friendly game powered by real Renaiss cards",
    "app.dataSourcePrefix": "Data from ",
    "app.dataSourceSuffix": " · Official marketplace and packs via the ",
    "app.disconnected": "Connection lost — reconnecting…",
    "app.cardPoolMissing": "Card data could not be loaded — run npm run prefetch",
    "app.roomClosed.hostLeft": "The room closed because the host left",
    "app.roomClosed.default": "The room has closed ({reason})",
    "app.roomMissing": "Room details are unavailable.",
    "app.backToLobby": "← Back to Lobby",
    "app.start": "GO!",
    "app.footer": "Prices and grades are sourced from Renaiss OS Index. Non-commercial fan prototype.",

    "login.nickname": "Guest nickname",
    "login.nicknameHint": "(1–12 characters)",
    "login.placeholder": "Enter a nickname",
    "login.connecting": "Connecting…",
    "login.start": "Play as Guest",
    "login.demoNote": "The demo lets you jump in with just a nickname. The full release will connect your Renaiss account through X (Twitter) or a Web3 wallet.",

    "lobby.defaultRoomName": "{name}'s Room",
    "lobby.soloRoomName": "{name}'s Solo Game",
    "lobby.refresh": "Refresh",
    "lobby.createRoom": "Create Room",
    "lobby.quickStart": "Quick Play",
    "lobby.roomTitle": "Room",
    "lobby.map": "Map",
    "lobby.players": "Players",
    "lobby.host": "Host",
    "lobby.loading": "Loading rooms…",
    "lobby.empty": "No rooms are open yet. Create one or jump straight into Quick Play.",
    "lobby.passwordRoom": "Password-protected room",
    "lobby.inProgress": "Playing",
    "lobby.full": "Full",
    "lobby.join": "Join",
    "lobby.myProfile": "My Profile",
    "lobby.totalPlays": "Games Played",
    "lobby.wins": "1st Place Finishes",
    "lobby.dexProgress": "Dex Completion",
    "lobby.marketTitleLine1": "Own real cards",
    "lobby.marketTitleLine2": "online",
    "lobby.marketDesc": "Own PSA-graded cards digitally and redeem the physical cards whenever you want.",
    "lobby.marketLink": "Explore the Market →",
    "lobby.dex": "Card Dex",
    "lobby.settings": "Settings",
    "lobby.settingsPending": "Settings are coming soon",
    "lobby.roomName": "Room name",
    "lobby.maxPlayers": "Max players",
    "lobby.playerCount": "{count} players",
    "lobby.visibility": "Visibility",
    "lobby.public": "Public",
    "lobby.private": "Private",
    "lobby.password": "Password",
    "lobby.passwordPlaceholder": "Leave blank for no password",
    "lobby.cards": "Cards",
    "lobby.mapNote": "After creating the room, the host can choose the map mode and difficulty in the waiting room.",
    "lobby.cancel": "Cancel",
    "lobby.privatePrompt": "This room is private. Enter the password to join.",

    "map.selectTitle": "{name} — Select Map",
    "map.type": "Map Type",
    "map.difficulty": "Difficulty",
    "map.all": "All",
    "map.exclusive": "{game} only",
    "map.empty": "No maps match these filters.",
    "map.cancel": "Cancel",
    "map.confirm": "Confirm Selection",
    "map.diff.easy": "Beginner",
    "map.diff.normal": "Intermediate",
    "map.diff.hard": "Advanced",
    "map.preset.straw-hat": "Straw Hat",
    "map.preset.devil-fruit": "Devil Fruit",
    "map.preset.monster-ball": "Poké Ball",
    "map.preset.pikachu": "Pikachu",
    "map.preset.charizard": "Charizard",
    "map.preset.jolly-roger": "Jolly Roger",
    "map.preset.bulbasaur": "Bulbasaur",
    "map.preset.squirtle": "Squirtle",
    "map.preset.luffy": "Monkey D. Luffy",
    "map.preset.nami": "Nami",
    "map.preset.sudowoodo": "Sudowoodo",
    "map.preset.mewtwo": "Mewtwo",
    "map.preset.chopper": "Tony Tony Chopper",
    "map.preset.going-merry": "Going Merry",

    "label.game.pokemon": "Pokémon",
    "label.game.one-piece": "One Piece",
    "label.mode.normal": "Classic",
    "label.mode.rolling": "Rolling",
    "label.mode.up": "UP",
    "label.mode.victory": "Victory",
    "label.mode.shanghai": "Shanghai",
    "label.modeDesc.normal": "Standard matching rules",
    "label.modeDesc.rolling": "The outer ring rotates clockwise every 4 seconds",
    "label.modeDesc.up": "Wide board · when no moves remain, a new row rises from the bottom",
    "label.modeDesc.victory": "Match the Victory Card pair first to take 1st place instantly",
    "label.modeDesc.shanghai": "Layered tiles · clear the upper layers to reach the tiles below",
    "label.diff.easy": "Easy",
    "label.diff.normal": "Normal",
    "label.diff.hard": "Hard",
    "label.state.waiting": "Waiting",
    "label.state.ended": "Finished",
    "label.state.playing": "In Progress",

    "error.notFound": "Room not found",
    "error.full": "The room is full",
    "error.playing": "This game is already in progress",
    "error.badPassword": "Incorrect password",
    "error.notHost": "Only the host can do that",
    "error.badNickname": "Nickname must be 1–12 characters",
    "error.badRequest": "Invalid request",
    "error.notInRoom": "You are not in a room",
    "error.notPlaying": "You are not currently playing",
    "error.quota": "You have used all of this item",
    "error.noQuota": "You have used all of this item",
    "error.noPower": "No combo effect is active",
    "error.notComplete": "Complete the Card Dex first",
    "error.alreadyClaimed": "Reward already claimed",
    "error.timeout": "The server did not respond — make sure it is running",
    "error.generic": "Something went wrong",
    "error.genericDetail": "Something went wrong ({error})",
  },
};

function loadLang(): Lang {
  if (typeof window === "undefined") return "ko";
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

let currentLang: Lang = loadLang();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getLang(): Lang {
  return currentLang;
}

export function setLang(lang: Lang): void {
  if (lang === currentLang) return;
  currentLang = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 저장소 사용이 차단되어도 현재 세션의 언어 전환은 유지한다.
  }
  listeners.forEach((listener) => listener());
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const template = DICT[currentLang][key] ?? DICT.ko[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

export function useLang(): { lang: Lang; setLang: typeof setLang } {
  const lang = useSyncExternalStore(subscribe, getLang, (): Lang => "ko");
  return { lang, setLang };
}
