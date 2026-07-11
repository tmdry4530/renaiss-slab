// F-01 로그인 (데모 범위): 게스트 닉네임(1~12자) → lobby:hello
// 실서비스 스펙(X OAuth / Web3 지갑)은 데모에서 게스트 로그인으로 대체한다.
import { useState } from "react";
import { audio } from "../audio.ts";
import { t } from "../i18n.ts";

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
    audio.unlock(); // 첫 사용자 제스처 — 자동재생 정책 언락(AudioContext.resume)
    setBusy(true);
    const ok = await onSubmit(trimmed);
    if (!ok) setBusy(false);
  }

  return (
    <section className="login">
      <div className="login-card">
        <div className="login-logo">♔</div>
        <h2>Renaiss Slab King</h2>
        <p className="tagline">{t("app.tagline")}</p>
        <form onSubmit={submit}>
          <label htmlFor="nick">
            {t("login.nickname")} <span className="muted">{t("login.nicknameHint")}</span>
          </label>
          <input
            id="nick"
            value={nick}
            maxLength={12}
            autoFocus
            placeholder={t("login.placeholder")}
            onChange={(e) => setNick(e.target.value)}
          />
          <button className="btn primary big" type="submit" disabled={!valid || busy}>
            {busy ? t("login.connecting") : t("login.start")}
          </button>
        </form>
        <p className="muted small">
          {t("login.demoNote")}
        </p>
      </div>
    </section>
  );
}
