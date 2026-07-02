// F-01 로그인 (데모 범위): 게스트 닉네임(1~12자) → lobby:hello
// 실서비스 스펙(X OAuth / Web3 지갑)은 데모에서 게스트 로그인으로 대체한다.
import { useState } from "react";

interface Props {
  initial: string;
  /** 접속 시도. 성공 여부를 반환 (실패 시 버튼 잠금 해제) */
  onSubmit: (nickname: string) => Promise<boolean>;
}

export default function Login({ initial, onSubmit }: Props) {
  const [nick, setNick] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trimmed = nick.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= 12;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onSubmit(trimmed);
    if (!ok) setBusy(false);
  }

  return (
    <section className="login">
      <div className="login-card">
        <div className="login-logo">♔</div>
        <h2>Renaiss Slab King</h2>
        <p className="tagline">실제 Renaiss 카드로 즐기는 입문 게임</p>
        <form onSubmit={submit}>
          <label htmlFor="nick">게스트 닉네임 <span className="muted">(1~12자)</span></label>
          <input
            id="nick"
            value={nick}
            maxLength={12}
            autoFocus
            placeholder="닉네임을 입력하세요"
            onChange={(e) => setNick(e.target.value)}
          />
          <button className="btn primary big" type="submit" disabled={!valid || busy}>
            {busy ? "접속 중…" : "게스트로 시작"}
          </button>
        </form>
        <p className="muted small">
          데모에서는 닉네임만으로 바로 시작합니다. 실서비스에서는 X(트위터) 또는 Web3 지갑으로
          Renaiss 계정과 연동됩니다.
        </p>
      </div>
    </section>
  );
}
