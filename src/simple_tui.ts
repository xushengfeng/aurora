import * as Ansi from "@std/cli/unstable-ansi";

export { x as changeOut };

function x() {
	let lastHeight = -1;
	let lastT = "";
	return {
		update: (v: string) => {
			console.log(
				Ansi.moveCursorUp(lastHeight) + Ansi.deleteLines(lastHeight) + v,
			);
			const l = v.split("\n").length;
			lastHeight = l;
			lastT = v;
		},
		log: (v: string) => {
			console.log(
				Ansi.moveCursorUp(lastHeight) +
					Ansi.deleteLines(lastHeight) +
					v +
					"\n" +
					lastT,
			);
		},
	};
}
