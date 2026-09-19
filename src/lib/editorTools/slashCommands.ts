// Input autocomplete for the copilot: typing "/" surfaces prompt shortcuts, "@" surfaces the slide
// list (carousel only). Pure trigger detection + command lists so the panels only own the UI/keyboard.

export interface SlashCommand { cmd: string; label: string; prompt: string }

// Carousel prompt shortcuts. `prompt` is what the input expands to (the user can edit it before sending).
export const CAROUSEL_COMMANDS: SlashCommand[] = [
  { cmd: '/bigger', label: 'Bigger headline', prompt: 'Make the headline bigger and bolder' },
  { cmd: '/darker', label: 'Darker look', prompt: 'Give this slide a darker look' },
  { cmd: '/brand', label: 'Match brand', prompt: 'Restyle this slide to match my brand colors' },
  { cmd: '/swipe', label: 'Add swipe cue', prompt: 'Add a "SWIPE" cue in the corner' },
  { cmd: '/chart', label: 'Add a chart', prompt: 'Add a bar chart' },
  { cmd: '/cleaner', label: 'Cleaner layout', prompt: 'Simplify the layout and improve the spacing' },
];

// Reel prompt shortcuts (no @slide — a reel is a single overlay).
export const REEL_COMMANDS: SlashCommand[] = [
  { cmd: '/dark', label: 'Dark header', prompt: 'Make the header dark' },
  { cmd: '/caption', label: 'Bigger caption', prompt: 'Make the caption text bigger' },
  { cmd: '/avatar', label: 'Circle avatar', prompt: 'Make the avatar a circle with a ring' },
  { cmd: '/brand', label: 'Match brand', prompt: 'Match my brand colors' },
];

export interface Trigger { type: '/' | '@'; query: string; start: number }

// Find an autocomplete trigger ending at the caret: a "/" or "@" that begins the current word (at the
// start of the input or after whitespace) with only the caret's word after it. Returns null otherwise
// (e.g. mid-word "a/b", an email "me@x", or a completed word followed by a space).
export function findTrigger(text: string, caret: number): Trigger | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) {
    if (text[i] === '/' || text[i] === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) {
        return { type: text[i] as '/' | '@', query: text.slice(i + 1, caret), start: i };
      }
      return null;   // "/" or "@" is mid-word, not a trigger
    }
    i--;
  }
  return null;
}

export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter(c => c.cmd.slice(1).startsWith(q) || c.label.toLowerCase().includes(q));
}

// Replace the WHOLE trigger token with `insert`, keeping exactly one space before whatever follows (no
// double space when a space already follows). The token runs from `start` to the end of its
// whitespace-delimited run — which may extend past the caret if the caret sits mid-token — so no tail
// is left behind. Returns the new text and the caret position after the insertion.
export function applyInsertion(text: string, start: number, caret: number, insert: string): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const after = text.slice(end);
  const sep = after.startsWith(' ') ? '' : ' ';
  return { text: text.slice(0, start) + insert + sep + after, caret: start + insert.length + sep.length };
}
