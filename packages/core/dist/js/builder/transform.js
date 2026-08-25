export class TransformBuilder {
    data = {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        origin: [0, 0, 0],
    };
    translateX(x) {
        this.data.translation[0] = x;
        return this;
    }
    translateY(y) {
        this.data.translation[1] = y;
        return this;
    }
    translateZ(z) {
        this.data.translation[2] = z;
        return this;
    }
    translate(x, y, z = 0) {
        this.data.translation = [x, y, z];
        return this;
    }
    scale(sx, sy, sz = 1) {
        if (sy === undefined) {
            this.data.scale = [sx, sx, sx];
        }
        else {
            this.data.scale = [sx, sy, sz];
        }
        return this;
    }
    rotationQuat(x, y, z, w) {
        this.data.rotation_quat = [x, y, z, w];
        return this;
    }
    origin(x, y, z = 0) {
        this.data.origin = [x, y, z];
        return this;
    }
    build() {
        return { ...this.data };
    }
}
