"""PostgreSQL database configuration and connection"""
from app.core.config import settings


class DatabaseSettings:
    """PostgreSQL/Neon database settings wrapper"""
    
    @property
    def url(self):
        return settings.database_url
    
    @property
    def echo_sql(self):
        return settings.database_echo_sql
    
    @property
    def pool_size(self):
        return settings.database_pool_size
    
    @property
    def max_overflow(self):
        return settings.database_max_overflow
    
    @property
    def pool_timeout(self):
        return settings.database_pool_timeout
    
    @property
    def pool_recycle(self):
        return settings.database_pool_recycle
