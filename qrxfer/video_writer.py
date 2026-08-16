import cv2
import numpy as np
import logging

logger = logging.getLogger(__name__)


class VideoWriter:
    def __init__(
        self,
        output_path,
        fps=5,
        frame_size=(776, 776),
        codec_priority=("mp4v", "avc1", "H264", "XVID", "MJPG"),
    ):
        self.output_path = output_path
        self.fps = fps
        self.frame_size = frame_size
        self.writer = None
        self.codec_priority = codec_priority
        self.active_codec = None

    def open(self):
        logger.info("Opening video writer: %s", self.output_path)
        for codec in self.codec_priority:
            fourcc = cv2.VideoWriter_fourcc(*codec)
            writer = cv2.VideoWriter(
                self.output_path, fourcc, float(self.fps), self.frame_size, True
            )
            if writer.isOpened():
                self.writer = writer
                self.active_codec = codec
                break

        if self.writer and hasattr(cv2, "VIDEOWRITER_PROP_QUALITY"):
            self.writer.set(cv2.VIDEOWRITER_PROP_QUALITY, 100)

        if not self.writer or not self.writer.isOpened():
            raise IOError("Could not open video writer")

        logger.info(
            "Video writer opened: %s fps, size %s, codec %s",
            self.fps,
            self.frame_size,
            self.active_codec,
        )

    def write_frame(self, frame_rgb):
        if self.writer is None:
            raise RuntimeError("Video writer not opened")
        frame = frame_rgb
        if frame.shape[1] != self.frame_size[0] or frame.shape[0] != self.frame_size[1]:
            frame = cv2.resize(frame, self.frame_size, interpolation=cv2.INTER_NEAREST)
        frame_bgr = cv2.cvtColor(frame.astype(np.uint8), cv2.COLOR_RGB2BGR)
        self.writer.write(frame_bgr)

    def close(self):
        if self.writer:
            self.writer.release()
            self.writer = None
            logger.info("Video saved: %s", self.output_path)
