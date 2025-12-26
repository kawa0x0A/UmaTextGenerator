let _state = {
    bgImg: null,          // HTMLImageElement
    bgObjectUrl: null,    // object URL for background image
    fontFamily: null,
    customFontFamily: null,
    separatorImg: null,
};

function revokeObjectUrl(url) {
    try { if (url) URL.revokeObjectURL(url); } catch { }
}

function clamp01(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * wwwroot/fonts に同梱したフォントを読み込む
 * @param {string} family フォント名（Canvasで使う名前）
 * @param {string} url    フォントファイルのURL
 * @param {number} weight フォントウェイト（400,700など）
 */
export async function loadBundledFont(family, url, weight = 400) {
    const font = new FontFace(
        family,
        `url(${url})`,
        { weight: String(weight), style: "normal" }
    );

    await font.load();
    document.fonts.add(font);

    _state.fontFamily = family;
    _state.fontLoaded = true;
}

/**
 * 背景画像を bytes から読み込み、canvas を「元画像サイズ」に合わせる
 * => 出力PNGも元画像サイズになる
 */
export async function setBackgroundImageFromBytes(canvasId, bytes) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error("canvas not found");

    // bytes: Uint8Array (Blazor から byte[] が渡る)
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);

    const img = new Image();
    img.decoding = "async";
    img.src = url;

    await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("failed to load image"));
    });

    // clean old url
    revokeObjectUrl(_state.bgObjectUrl);
    _state.bgObjectUrl = url;
    _state.bgImg = img;

    // ✅ canvas を元画像サイズに揃える（= 出力サイズ固定）
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
}

/**
 * フォントファイル（ttf/otf）を bytes から読み込み、ブラウザに登録する
 */
export async function loadFontFromBytes(fontBytes, familyName) {
    const blob = new Blob([fontBytes], { type: "font/ttf" });
    const url = URL.createObjectURL(blob);

    const fontFace = new FontFace(familyName, `url(${url})`);
    await fontFace.load();
    document.fonts.add(fontFace);

    _state.customFontFamily = familyName;

    // フォント読込後はURLは不要
    revokeObjectUrl(url);
}

export function clearCustomFont() {
    _state.customFontFamily = null;
}

/**
 * wwwroot から線画像をロード（1回でOK）
 */
export async function loadSeparatorImage(url) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;

    await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("failed to load separator image"));
    });

    _state.separatorImg = img;
}

/**
 * 改行/折り返しを考慮して行配列にする
 * - 明示改行は保持
 * - 横幅超過は単純な単語分割 + 追加（日本語でもそこそこ動く）
 */
function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    const raw = (text ?? "").replace(/\r\n/g, "\n").split("\n");

    for (const paragraph of raw) {
        // 空行でも1行扱いにする
        if (paragraph.length === 0) {
            lines.push(" ");
            continue;
        }

        // 単語境界（スペース含む）で分割：英語に強い。日本語は長文だと1塊になりがちなので、後段でフォールバックあり
        const words = paragraph.split(/(\s+)/);
        let line = "";

        for (const w of words) {
            const test = line + w;
            if (ctx.measureText(test).width <= maxWidth || line.length === 0) {
                line = test;
            } else {
                lines.push(line.trimEnd());
                line = w.trimStart();
            }
        }

        if (line.length > 0) lines.push(line.trimEnd());
    }

    // 日本語など「単語分割が効かない」場合のフォールバック（1行がmaxWidthを超えてたら文字単位で割る）
    const fixed = [];
    for (const l of lines) {
        if (ctx.measureText(l).width <= maxWidth) {
            fixed.push(l);
            continue;
        }
        let buf = "";
        for (const ch of l) {
            const test = buf + ch;
            if (ctx.measureText(test).width <= maxWidth || buf.length === 0) {
                buf = test;
            } else {
                fixed.push(buf);
                buf = ch;
            }
        }
        if (buf.length > 0) fixed.push(buf);
    }

    return fixed.map(l => (l === "" ? " " : l));
}

/**
 * canvas に描画する
 * options 例:
 * {
 *   characterName: string,
 *   bodyText: string,
 *   nameFontSize: number,
 *   bodyFontSize: number,
 *   showName: boolean,
 *   showLine: boolean,
 *   withShadow: boolean,
 *   shadowOffsetPx: number,
 *   addBottomBar: boolean,
 *   bottomBarHeightPx: number, // ✅ピクセル固定
 *   useCustomFont: boolean,
 *   fallbackFont: string
 * }
 */
export function render(canvasId, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error("canvas not found");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context not available");

    const img = _state.bgImg;
    if (!img) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }

    const cw = canvas.width;
    const ch = canvas.height;

    // ✅ 元画像を元サイズでそのまま描画（リサイズルールなし）
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);

    // ---- Font selection ----
    const family = (options.useCustomFont && _state.customFontFamily)
        ? _state.customFontFamily
        : (_state.fontFamily || "sans-serif");

    // ---- Shadow ----
    const withShadow = !!options.withShadow;
    const shadowOffset = Math.max(0, options.shadowOffsetPx ?? 2);

    function applyShadow() {
        if (!withShadow) {
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            return;
        }
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = shadowOffset;
        ctx.shadowOffsetY = shadowOffset;
    }

    // ---- Common text style ----
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "white";

    const maxTextWidth = cw;

    // ---- Name ----
    const showName = !!options.showName;
    if (showName) {
        const nameSize = Math.max(10, options.nameFontSize ?? 56);

        const nameX01 = clamp01(options.nameX01 ?? 0.20);
        const nameY01 = clamp01(options.nameY01 ?? 0.80);

        const nameX = Math.round(lerp(0, cw, nameX01));
        const nameY = Math.round(lerp(0, ch, nameY01));

        ctx.font = `700 ${nameSize}px "${family}"`;

        applyShadow();

        ctx.fillText(options.characterName ?? "", nameX, nameY);
    }

    // Optional line under name
    if (options.showLine && _state.separatorImg) {
        ctx.save();

        // 影は付けない（必要ならここで調整）
        ctx.shadowColor = "transparent";

        const img = _state.separatorImg;

        const drawWidth = 552;
        const drawHeight = 8;

        const barX01 = clamp01(options.nameX01 - 0.25 ?? 0.20);
        const barY01 = clamp01(options.nameY01 + 0.025 ?? 0.80);

        // 位置：名前の少し下
        const barX = Math.round(lerp(0, cw, barX01));
        const barY = Math.round(lerp(0, ch, barY01));

        ctx.globalAlpha = 1.0; // お好みで
        ctx.drawImage(img, barX, barY, drawWidth, drawHeight);

        ctx.restore();
    }

    // ---- Body ----
    const bodySize = Math.max(10, options.bodyFontSize ?? 50);
    ctx.font = `700 ${bodySize}px "${family}"`;
    applyShadow();

    const bodyText = options.bodyText ?? "";
    const lines = wrapLines(ctx, bodyText, maxTextWidth);

    const bodyX01 = clamp01(options.bodyX01 ?? 0.20);
    const bodyY01 = clamp01(options.bodyY01 ?? 0.80);

    const bodyAnchorX = Math.round(lerp(0, cw, bodyX01));
    const bodyAnchorY = Math.round(lerp(0, ch, bodyY01));

    const lineHeight = Math.round(bodySize * 1.15);

    let drawLines = lines;

    for (let i = 0; i < drawLines.length; i++) {
        ctx.fillText(drawLines[i], bodyAnchorX, bodyAnchorY + i * lineHeight);
    }
}

/**
 * canvas をPNGでダウンロード
 */
export function downloadPng(canvasId, filename) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) throw new Error("canvas not found");

    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename || "image.png";
        a.click();

        setTimeout(() => revokeObjectUrl(url), 500);
    }, "image/png");
}

/**
 * 背景画像の ObjectURL を明示的に破棄したい場合用（任意）
 */
export function disposeBackground() {
    revokeObjectUrl(_state.bgObjectUrl);
    _state.bgObjectUrl = null;
    _state.bgImg = null;
}
