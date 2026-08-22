import { RouterProvider } from "@tanstack/solid-router";
import { render } from "solid-js/web";
import { router } from "./routes.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

render(() => <RouterProvider router={router} />, root);
