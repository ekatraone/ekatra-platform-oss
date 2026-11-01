/**
 * whatsappFormatter.ts
 *
 * Converts markdown / LLM output to WhatsApp-native formatting.
 * Ported from ekatra-whatsapp/utils/whatsappFormatter.js
 *
 * WhatsApp formatting:
 *   *bold*   _italic_   ~strikethrough~   ```monospace```
 */

export function markdownToWhatsApp(text: string): string {
  if (!text || typeof text !== 'string') return text || '';

  let result = text;

  // 1. Protect existing code blocks — replace with placeholders
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // 2. Convert markdown headers (## Header → *Header*)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // 3. Convert **bold** → *bold*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // 4. Convert __bold__ → *bold*
  result = result.replace(/__(.+?)__/g, '*$1*');

  // 5. Convert unordered list markers: "- item" → "• item"
  result = result.replace(/^[\-]\s+/gm, '• ');
  result = result.replace(/^\*\s+(?!\*)/gm, '• ');

  // 6. Convert markdown links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // 7. Clean up excessive blank lines (3+ → 2)
  result = result.replace(/\n{3,}/g, '\n\n');

  // 8. Fix double-bold artifacts from conversions (****text**** → *text*)
  result = result.replace(/\*{2,}([^*]+)\*{2,}/g, '*$1*');

  // 9. Restore code blocks
  codeBlocks.forEach((block, i) => {
    result = result.replace(`__CODE_BLOCK_${i}__`, block);
  });

  return result.trim();
}
