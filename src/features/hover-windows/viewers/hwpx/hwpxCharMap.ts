// ==================== Character Mapping ====================

/** Map PUA (Private Use Area) character codes to Unicode equivalents (Wingdings/Symbol/HWP) */
export function mapPuaChar(code: number): string {
  // PUA range 0xF020-0xF0FF: Wingdings/HWP symbol characters
  if (code >= 0xF020 && code <= 0xF0FF) {
    const wc = code - 0xF000;
    const MAP: Record<number, number> = {
      // Wingdings 1 symbols (0x20-0x2F)
      0x20: 0x0020, //   Space
      0x21: 0x270C, // ✌ Victory hand
      0x22: 0x2702, // ✂ Scissors
      0x23: 0x2701, // ✁ Scissors (alt)
      0x24: 0x1F453, // 👓 Eyeglasses
      0x25: 0x1F514, // 🔔 Bell
      0x26: 0x1F4D6, // 📖 Open book
      0x27: 0x1F56F, // 🕯 Candle
      0x28: 0x260E, // ☎ Telephone
      0x29: 0x2706, // ✆ Telephone location sign
      0x2A: 0x2709, // ✉ Envelope
      0x2B: 0x2708, // ✈ Airplane
      0x2C: 0x263C, // ☼ Sun
      0x2D: 0x2600, // ☀ Sun with rays
      0x2E: 0x2744, // ❄ Snowflake
      0x2F: 0x271E, // ✞ Cross
      // Card suits & religious symbols (0x45-0x4E)
      0x45: 0x2660, // ♠ Spade suit
      0x46: 0x261C, // ☜ Left pointing
      0x47: 0x261E, // ☞ Right pointing
      0x48: 0x261D, // ☝ Up pointing
      0x49: 0x261F, // ☟ Down pointing
      0x4A: 0x270B, // ✋ Raised hand
      0x4B: 0x270A, // ✊ Raised fist
      0x4C: 0x2736, // ✶ Six pointed star
      0x4D: 0x2735, // ✵ Eight pointed star
      0x4E: 0x2734, // ✴ Eight pointed pinwheel star
      0x4F: 0x2733, // ✳ Eight spoked asterisk
      // Zodiac/decorative (0x50-0x6A)
      0x50: 0x2721, // ✡ Star of David
      0x51: 0x272A, // ✪ Circled white star
      0x52: 0x2318, // ⌘ Place of interest
      0x53: 0x2740, // ❀ White florette
      0x54: 0x273F, // ✿ Black florette
      0x55: 0x275D, // ❝ Heavy double turned comma quotation mark
      0x56: 0x275E, // ❞ Heavy double comma quotation mark
      0x57: 0x2761, // ❡ Curved stem paragraph sign ornament
      0x58: 0x2762, // ❢ Heavy exclamation mark ornament
      0x59: 0x2763, // ❣ Heavy heart exclamation
      0x5A: 0x2764, // ❤ Heavy black heart
      0x5B: 0x2765, // ❥ Rotated heavy black heart bullet
      0x5C: 0x2766, // ❦ Floral heart
      0x5D: 0x2767, // ❧ Rotated floral heart bullet
      0x5E: 0x2660, // ♠ Black spade suit
      0x5F: 0x2663, // ♣ Black club suit
      0x60: 0x2665, // ♥ Black heart suit
      0x61: 0x2666, // ♦ Black diamond suit
      0x62: 0x2660, // ♠ Spade
      0x63: 0x2663, // ♣ Club
      0x64: 0x2665, // ♥ Heart
      0x65: 0x2666, // ♦ Diamond
      0x66: 0x266A, // ♪ Eighth note
      0x67: 0x266B, // ♫ Beamed eighth notes
      0x68: 0x266C, // ♬ Beamed sixteenth notes
      0x69: 0x266D, // ♭ Music flat sign
      0x6A: 0x266E, // ♮ Music natural sign
      // Geometric shapes and faces (0x6B-0x7D)
      0x6B: 0x263A, // ☺ Smiley face
      0x6C: 0x2605, // ★ Black star
      0x6D: 0x2606, // ☆ White star
      0x6E: 0x2611, // ☑ Ballot box with check
      0x6F: 0x2610, // ☐ Ballot box
      0x70: 0x2639, // ☹ White frowning face
      0x71: 0x2612, // ☒ Ballot box with X
      0x72: 0x2316, // ⌖ Position indicator
      0x73: 0x25C6, // ◆ Black diamond
      0x74: 0x25C7, // ◇ White diamond
      0x75: 0x25C6, // ◆ Black diamond (alt)
      0x76: 0x25CF, // ● Black circle
      0x77: 0x25CB, // ○ White circle
      0x78: 0x25A0, // ■ Black square
      0x79: 0x25A1, // □ White square
      0x7A: 0x25B2, // ▲ Black up triangle
      0x7B: 0x25B3, // △ White up triangle
      0x7C: 0x25BC, // ▼ Black down triangle
      0x7D: 0x25BD, // ▽ White down triangle
      // Additional shapes (0x7E-0x9D)
      0x7E: 0x25C0, // ◀ Black left triangle
      0x7F: 0x25B6, // ▶ Black right triangle
      0x80: 0x25C1, // ◁ White left triangle
      0x81: 0x25B7, // ▷ White right triangle
      0x82: 0x2B25, // ⬥ Black medium diamond
      0x83: 0x2B26, // ⬦ White medium diamond
      0x84: 0x25E2, // ◢ Black lower right triangle
      0x85: 0x25E3, // ◣ Black lower left triangle
      0x86: 0x25E4, // ◤ Black upper left triangle
      0x87: 0x25E5, // ◥ Black upper right triangle
      0x88: 0x25D0, // ◐ Circle with left half black
      0x89: 0x25D1, // ◑ Circle with right half black
      0x8A: 0x25D2, // ◒ Circle with lower half black
      0x8B: 0x25D3, // ◓ Circle with upper half black
      0x8C: 0x25EF, // ◯ Large circle
      0x8D: 0x25A2, // ▢ White square with rounded corners
      0x8E: 0x25AB, // ▫ White small square
      0x8F: 0x25AA, // ▪ Black small square
      0x90: 0x25FB, // ◻ White medium square
      0x91: 0x25FC, // ◼ Black medium square
      0x92: 0x2B1B, // ⬛ Black large square
      0x93: 0x2B1C, // ⬜ White large square
      0x94: 0x25B4, // ▴ Black up small triangle
      0x95: 0x25B5, // ▵ White up small triangle
      0x96: 0x25BE, // ▾ Black down small triangle
      0x97: 0x25BF, // ▿ White down small triangle
      0x98: 0x25C2, // ◂ Black left small triangle
      0x99: 0x25C3, // ◃ White left small triangle
      0x9A: 0x25B8, // ▸ Black right small triangle
      0x9B: 0x25B9, // ▹ White right small triangle
      0x9C: 0x25CD, // ◍ Circle with vertical fill
      0x9D: 0x25CC, // ◌ Dotted circle
      // Circle symbols (HWP common)
      0x9E: 0x25CB, // ○ White circle
      0x9F: 0x25CF, // ● Black circle
      0xA0: 0x00A0, // Non-breaking space
      // Office symbols
      0xA1: 0x270E, // ✎ Pencil
      0xA2: 0x270F, // ✏ Pencil (alt)
      0xA3: 0x2702, // ✂ Scissors
      0xA4: 0x2709, // ✉ Envelope
      0xA5: 0x270D, // ✍ Writing hand
      0xA6: 0x2710, // ✐ Upper right pencil
      // Squares and rectangles
      0xA7: 0x25AA, // ▪ Black small square
      0xA8: 0x25A0, // ■ Black square
      0xA9: 0x25A1, // □ White square
      0xAA: 0x25A3, // ▣ White square containing black square
      0xAB: 0x25A4, // ▤ Square with horizontal fill
      0xAC: 0x2666, // ♦ Diamond suit
      0xAD: 0x25C6, // ◆ Black diamond
      0xAE: 0x25A5, // ▥ Square with vertical fill
      0xAF: 0x25A6, // ▦ Square with orthogonal crosshatch fill
      // Arrows
      0xB0: 0x2190, // ← Left arrow
      0xB1: 0x2191, // ↑ Up arrow
      0xB2: 0x2192, // → Right arrow
      0xB3: 0x2193, // ↓ Down arrow
      0xB4: 0x2194, // ↔ Left right arrow
      0xB5: 0x2195, // ↕ Up down arrow
      0xB6: 0x25B6, // ▶ Right pointing triangle
      0xB7: 0x25C0, // ◀ Left pointing triangle
      0xB8: 0x21D0, // ⇐ Left double arrow
      0xB9: 0x21D1, // ⇑ Up double arrow
      0xBA: 0x21D2, // ⇒ Right double arrow
      0xBB: 0x21D3, // ⇓ Down double arrow
      0xBC: 0x21D4, // ⇔ Left right double arrow
      0xBD: 0x21D5, // ⇕ Up down double arrow
      0xBE: 0x21B0, // ↰ Upwards arrow with tip leftwards
      0xBF: 0x21B1, // ↱ Upwards arrow with tip rightwards
      // Extended arrows and symbols (0xC0-0xCF)
      0xC0: 0x21B2, // ↲ Downwards arrow with tip leftwards
      0xC1: 0x21B3, // ↳ Downwards arrow with tip rightwards
      0xC2: 0x21B6, // ↶ Anticlockwise top semicircle arrow
      0xC3: 0x21B7, // ↷ Clockwise top semicircle arrow
      0xC4: 0x21BA, // ↺ Anticlockwise open circle arrow
      0xC5: 0x21BB, // ↻ Clockwise open circle arrow
      0xC6: 0x21C4, // ⇄ Rightwards arrow over leftwards arrow
      0xC7: 0x21C5, // ⇅ Upwards arrow leftwards of downwards arrow
      0xC8: 0x21C6, // ⇆ Leftwards arrow over rightwards arrow
      0xC9: 0x21E6, // ⇦ Leftwards white arrow
      0xCA: 0x21E7, // ⇧ Upwards white arrow
      0xCB: 0x21E8, // ⇨ Rightwards white arrow
      0xCC: 0x21E9, // ⇩ Downwards white arrow
      0xCD: 0x27A1, // ➡ Black rightwards arrow
      0xCE: 0x2B05, // ⬅ Leftwards black arrow
      0xCF: 0x2B06, // ⬆ Upwards black arrow
      // Stars and decorations (0xD0-0xEF)
      0xD0: 0x2B07, // ⬇ Downwards black arrow
      0xD1: 0x2729, // ✩ Stress outlined white star
      0xD2: 0x272B, // ✫ Open centre black star
      0xD3: 0x272C, // ✬ Black centre white star
      0xD4: 0x272D, // ✭ Outlined black star
      0xD5: 0x232B, // ⌫ Delete
      0xD6: 0x2730, // ✰ Shadowed white star
      0xD7: 0x2731, // ✱ Heavy asterisk
      0xD8: 0x2732, // ✲ Open centre asterisk
      0xD9: 0x273D, // ✽ Heavy teardrop spoked asterisk
      0xDA: 0x2742, // ❂ Circled open centre eight pointed star
      0xDB: 0x2743, // ❃ Heavy teardrop spoked pinwheel asterisk
      0xDC: 0x2749, // ❉ Balloon spoked asterisk
      0xDD: 0x274A, // ❊ Teardrop spoked asterisk
      0xDE: 0x274B, // ❋ Heavy teardrop pinwheel asterisk
      0xDF: 0x2720, // ✠ Maltese cross
      0xE0: 0x2722, // ✢ Four teardrop spoked asterisk
      0xE1: 0x2723, // ✣ Four balloon spoked asterisk
      0xE2: 0x2724, // ✤ Heavy four balloon spoked asterisk
      0xE3: 0x2725, // ✥ Four club spoked asterisk
      0xE4: 0x2726, // ✦ Black four pointed star
      0xE5: 0x2727, // ✧ White four pointed star
      0xE6: 0x2741, // ❁ Eight petalled outlined black florette
      0xE7: 0x2746, // ❆ Six pointed black star
      0xE8: 0x2747, // ❇ Sparkle
      0xE9: 0x2748, // ❈ Heavy sparkle
      0xEA: 0x274D, // ❍ Shadowed white circle
      0xEB: 0x2750, // ❐ Upper right drop shadowed white square
      0xEC: 0x2751, // ❑ Lower right drop shadowed white square
      0xED: 0x2752, // ❒ Upper right shadowed white square
      0xEE: 0x2753, // ❓ Black question mark ornament
      0xEF: 0x2754, // ❔ White question mark ornament
      // Final symbols (0xF0-0xFF)
      0xF0: 0x2756, // ❖ Black diamond minus white X
      0xF1: 0x2756, // ❖
      0xF2: 0x25C9, // ◉ Fisheye
      0xF3: 0x2755, // ❕ White exclamation mark ornament
      0xF4: 0x2757, // ❗ Heavy exclamation mark
      0xF5: 0x2758, // ❘ Light vertical bar
      0xF6: 0x2759, // ❙ Medium vertical bar
      0xF7: 0x275A, // ❚ Heavy vertical bar
      0xF8: 0x275B, // ❛ Heavy single turned comma quotation mark
      0xF9: 0x275C, // ❜ Heavy single comma quotation mark
      0xFA: 0x2713, // ✓ Check mark
      0xFB: 0x2717, // ✗ Ballot X
      0xFC: 0x2714, // ✔ Heavy check mark
      0xFD: 0x2718, // ✘ Heavy ballot X
      0xFE: 0x2716, // ✖ Heavy multiplication X
      0xFF: 0x2022, // • Bullet
    };
    const mapped = MAP[wc];
    if (mapped) return String.fromCodePoint(mapped);

    // Circled numbers: PUA 0xF031-0xF039 → ① ② ③ ... ⑨
    if (wc >= 0x31 && wc <= 0x39) {
      return String.fromCodePoint(0x2460 + (wc - 0x31)); // ①②③④⑤⑥⑦⑧⑨
    }
    // Circled 10-20: 0xF030 area variations
    if (wc === 0x30) return '\u24EA'; // ⓪
    if (wc >= 0x3A && wc <= 0x43) {
      return String.fromCodePoint(0x2469 + (wc - 0x3A)); // ⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲
    }
    if (wc === 0x44) return '\u2473'; // ⑳

    // Fallback for unmapped PUA: use small bullet (not ● which is too large)
    return '\u2022';
  }
  return String.fromCodePoint(code);
}
