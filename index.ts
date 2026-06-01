import { Router, type IRouter } from "express";
import healthRouter from "./health";
import masterxRouter from "./masterx";

const router: IRouter = Router();

router.use(healthRouter);
router.use(masterxRouter);

export default router;
