import { NativeModule, requireNativeModule } from 'expo';

declare class EstimitVisionModule extends NativeModule<{}> {
  processImageAsync(uri: string): Promise<string>;
}

export default requireNativeModule<EstimitVisionModule>('EstimitVision');
