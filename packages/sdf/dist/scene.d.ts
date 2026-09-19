export type PrimType = 'box' | 'sphere' | 'cyl' | 'torus' | 'capsule' | 'boltring';
export type TransType = 'sharp' | 'fillet' | 'chamfer' | 'wave' | 'lap';
export type OpType = 'union' | 'sub' | 'inter';
/** 动画通道（运动学求解器按通道反算基元位姿） */
export type AnimKind = 'disc' | 'pin' | 'bolts' | 'rod' | 'piston' | 'none';
export interface SdfPrim {
    type: PrimType;
    /** 逻辑空间位姿（动画通道会在每帧覆写 _wp/_wq） */
    pos: [number, number, number];
    quat?: [number, number, number, number];
    /** 类型参数: box 半长xyz / sphere r / cyl r,halfH / torus R,r / capsule r,halfLen / boltring r,halfH,count,ringR */
    p: number[];
    /** 材质标签: 0结构钢 1铸铁 2紫铜 3光学玻璃 4密封橡胶 5信号涂层 6滚花钢 */
    label: number;
    /** 材质硬度 0..1（磨损增殖规则的易损判定输入） */
    hardness: number;
    anim?: AnimKind;
    /** 每帧求解出的世界位姿（solveKinematics 写入） */
    _wp?: [number, number, number];
    _wq?: [number, number, number, number];
}
export interface SdfBond {
    op: OpType;
    trans: TransType;
    /** 过渡半径（fillet/wave/lap 的 smin 宽度；sub/inter 的平滑宽） */
    radius?: number;
    /** 波浪熔接参数 */
    waveAmp?: number;
    waveFreq?: number;
    /** 变半径倒角: k = k0 + k1·(沿 chamAxis 的坐标) */
    chamAxis?: 0 | 1 | 2;
    k0?: number;
    k1?: number;
}
export interface SdfScene {
    name: string;
    prims: SdfPrim[];
    /** bonds[i] 描述基元 i 如何并入累加器（bonds[0] 占位） */
    bonds: SdfBond[];
    /** 全局包围球（射线预剔除） */
    boundC: [number, number, number];
    boundR: number;
    /** 曲柄滑块运动学参数（null = 无该机构） */
    kin: {
        c: [number, number, number];
        R: number;
        L: number;
        freq: number;
    } | null;
    /** 转台角速度 rad/s（整体绕 Y 慢转） */
    turntable: number;
    /** 集群增殖域重复实例层（on=false 或缺省 = 单物体） */
    cluster?: {
        on: boolean;
        cellSize: number;
        spreadAmp: number;
    } | null;
}
export declare const LABELS: string[];
type Q = [number, number, number, number];
export declare function axisAngle(ax: [number, number, number], a: number): Q;
export declare function qmul(a: Q, b: Q): Q;
export declare function solveKinematics(sc: SdfScene, t: number): void;
export declare const PRESETS: SdfScene[];
export type ValidateResult = {
    ok: true;
    scene: SdfScene;
} | {
    ok: false;
    error: string;
};
export declare function validateScene(raw: unknown): ValidateResult;
export {};
