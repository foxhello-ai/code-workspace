import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./AuthGate";
import { installChunkRecovery } from "./chunkRecovery";

installChunkRecovery();
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><AuthGate/></React.StrictMode>);
