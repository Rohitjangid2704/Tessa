import { installBearerExtension } from "../handlers/api";
import { recordBearerWrite } from "./bearer-writes";
import { isPersonalTokenSecret } from "./tokens-data";
import { tokensStore } from "./tokens-store";

installBearerExtension({
  recognizes: isPersonalTokenSecret,
  resolveUserId: (token) => tokensStore.resolveBearer(token),
  afterResponse: recordBearerWrite,
});
