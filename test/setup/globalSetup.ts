import { captureRealHomeForTests } from "./isolatedTestHome.js";

export default function setup() {
  captureRealHomeForTests();
  console.log(`Real home (forbidden): ${process.env.__TEST_REAL_HOME}`);
}
