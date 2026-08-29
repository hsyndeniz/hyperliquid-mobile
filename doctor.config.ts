// Consumed by `bunx react-doctor`. The package is not a dependency of this
// project — it is run ephemerally — so its `react-doctor/api` types are not
// resolvable here and typing the object against them breaks `tsc --noEmit`.
// If react-doctor ever becomes a devDependency, restore:
//   import type { ReactDoctorConfig } from "react-doctor/api";
export default {
  lint: true,
  deadCode: true,
  verbose: false,
  diff: false,
  failOn: "none",
  ignore: {
    rules: [],
    files: [],
  },
};
