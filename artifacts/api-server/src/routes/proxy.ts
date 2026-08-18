import { Router } from "express";
import {
  handlePlaylistProxy,
  handleSegmentProxy,
} from "../lib/hlsProxy.js";

const router = Router();

router.all("/proxy/hls/:token", async (req, res) => {
  await handlePlaylistProxy(req, res);
});

router.all("/proxy/seg/:token", async (req, res) => {
  await handleSegmentProxy(req, res);
});

export default router;
