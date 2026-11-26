/**
 * Who else has a note open, from the awareness beside it.
 *
 * Being in a note here means having it in an editor: a device's editor says
 * who it is on the `user` field (`NoteCursors.publishUser`) the moment it
 * binds, while a device that only opened the note's socket to sync it says
 * nothing there. So a fill passing through every note on somebody's laptop
 * is not a person in this one, and a caret's owner is.
 *
 * An AI's caret is left out. It is drawn by the server for the seconds a
 * tool writes, and "has this note open" is not true of it.
 */

import { USER_FIELD, type CursorUser } from "../NoteCursors";

/** The names of the editors in a note other than this device's own, each once. */
export function editorsIn(
	states: Map<number, Record<string, unknown>>,
	ownClientId: number,
): string[] {
	const names: string[] = [];
	states.forEach((state, clientId) => {
		if (clientId === ownClientId) return;
		const user = state?.[USER_FIELD] as Partial<CursorUser> | undefined;
		const name = user?.name?.trim();
		if (!name || user?.ai === true) return;
		if (!names.includes(name)) names.push(name);
	});
	return names;
}

/**
 * The one line the restore dialog adds when somebody else is in the note,
 * or null when nobody is. Two people are named; more are counted.
 */
export function presenceLine(names: readonly string[]): string | null {
	if (names.length === 0) return null;
	if (names.length === 1) return `${names[0]} has this note open.`;
	if (names.length === 2) return `${names[0]} and ${names[1]} have this note open.`;
	return `${names[0]} and ${names.length - 1} others have this note open.`;
}
