/** Immutable model identity shared by browser, service and explicit installer. */
export const WHISPER_MODEL = 'onnx-community/whisper-base'
export const WHISPER_REVISION = '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c'
export const WHISPER_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'] as const
export const WHISPER_SAMPLE_RATE = 16000
