import { registerWebModule, NativeModule } from 'expo';

// EstimitVisionModule is not available on the web platform.
class EstimitVisionModule extends NativeModule<{}> {}

export default registerWebModule(EstimitVisionModule, 'EstimitVisionModule');
