// Names are metadata; never use them as region or geometry identifiers.
export function separationLayerName(sourceName, enteredName = '') {
  return enteredName.trim() || `Separation from ${sourceName}`;
}
