import uuid
from django.db import models
class SharedFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file = models.FileField(upload_to="uploads/%Y/%m/%d/")
    original_name = models.CharField(max_length=255)
    qr_code = models.ImageField(upload_to="qrcodes/")
    uploaded_at = models.DateTimeField(auto_now_add=True)
    download_count = models.PositiveIntegerField(default=0)
    file_size = models.PositiveBigIntegerField(default=0)
    class Meta:
        ordering = ["-uploaded_at"]
    def __str__(self):
        return self.original_name
