// The owner's page (.tracker/view.html): view.html beside this file, the state as data in a page
// that draws it. __DATA__ and __TITLE__ in it are filled in by view.ts.
import fs from "node:fs";

let page: string | undefined;
export const viewHtml = () => page ??= fs.readFileSync(new URL("./view.html", import.meta.url), "utf8");
