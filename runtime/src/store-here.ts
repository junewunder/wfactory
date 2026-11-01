// Which machine and lane the store runs for, settled once by storeCli.
export interface Here {
  host: string;         // this machine (FACTORY_HOST, else the hostname)
  lid: string;          // this lane's checkout: one "worked on" mark per lane
  branches: boolean;    // an origin: a unit's work reaches main only when its branch lands
  locks: string;        // the loop's lock folder, with its lane locks
}
export const here: Here = { host: "", lid: "", branches: false, locks: "" };
