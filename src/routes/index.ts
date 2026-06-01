import { Router, type IRouter } from "express";
import healthRouter from "./health";
import masterxRouter from "./masterx";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(masterxRouter);
router.use(aiRouter);

export default router;
