import application from "./index";
import { withHomologAccess } from "./homolog-access";

// Isolated entry point: wrangler.jsonc and the production entry stay unchanged.
export default withHomologAccess(application);
